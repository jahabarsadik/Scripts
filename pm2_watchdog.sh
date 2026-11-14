#!/usr/bin/env bash
#
# pm2_watchdog.sh - keep the portal running under pm2 (Linux). Run it from cron every 5 minutes.
#
# Each run:
#   1. pm2 itself not running (e.g. after a server restart)  -> pm2 is started
#   2. every app of ecosystem.config.js for this server      -> must be "online"
#        missing from pm2 (never started / deleted)            -> pm2 start ecosystem.config.js --only <app>
#        stopped / errored / stopping                          -> pm2 restart <app>
#   3. something was started                                 -> pm2 save (so pm2 remembers the apps)
#   Apps that are already online are left alone. Which apps: ecosystem.config.js decides (the same list as `npm start`:
#   sre-backend + sre-frontend-build on UAT / PROD). Runs on UAT and PROD servers only.
#
# Maintenance: create the file <APP_DIR>/.pm2-watchdog-pause and the watchdog does nothing until it is removed
# (e.g. while you stop the portal on purpose):   touch /opt/incident-portal/.pm2-watchdog-pause
#
# Options:
#   -n, --dry-run   only report what would be started; nothing is changed (pm2 is not started either)
#   -v, --verbose   also log "all online" runs (normally only runs that start something are logged)
#   -h, --help      show this help
#
# Settings: UAT_* / PROD_* folders in SETTINGS below (the environment comes from the hostname, as in config.js).
#
# Schedule (crontab -e, as the SAME user that runs pm2 for the portal):
#   */5 * * * * /opt/incident-portal/scripts/standalone/pm2_watchdog.sh >/dev/null 2>&1
#   @reboot sleep 60 && /opt/incident-portal/scripts/standalone/pm2_watchdog.sh >/dev/null 2>&1
#
# Log: <APP_DIR>/logs/pm2-watchdog-YYYYMMDD.log
# Exit codes: 0 all online (or started now), 1 not a UAT / PROD server or a setup problem (folder / node / pm2 not
#             found), 2 an app could not be started

set -u
set -o pipefail

# ============================== SETTINGS ==============================
# The environment is chosen from this server's hostname, the same rule as backend/src/config/config.js:
#   x01s*  -> UAT        x01g*  -> PROD        any other host: the script does nothing (exit 1)
UAT_HOST_PREFIX="x01s"
PROD_HOST_PREFIX="x01g"

# Per environment:
#   APP_DIR       the portal folder (the one with ecosystem.config.js); "" = two folders above this script
#   NODE_BIN_DIR  folder that holds node and npm (cron starts with a very short PATH); "" = search the usual places
#   PM2_HOME_DIR  pm2's home folder (its process list); "" = ~/.pm2 of the user running this script
UAT_APP_DIR="/CBGM/SREPORTAL"           # the portal folder
UAT_NODE_BIN_DIR=""     # e.g. "/opt/node-v24.11.0-linux-x64/bin"
UAT_PM2_HOME_DIR=""     # "" = ~/.pm2 of the portal user (the same pm2 as npm run start by hand)

PROD_APP_DIR="/CBGM/SREPORTAL"          # the portal folder
PROD_NODE_BIN_DIR=""    # e.g. "/opt/node-v24.11.0-linux-x64/bin"
PROD_PM2_HOME_DIR=""    # "" = ~/.pm2 of the portal user (the same pm2 as npm run start by hand)

# Seconds to wait after starting an app before checking it again
WAIT_AFTER_START=10
# Longest a single pm2 command may take (seconds), so a stuck pm2 never hangs the cron run (needs `timeout`)
PM2_TIMEOUT=120
# Days of watchdog log files to keep in <APP_DIR>/logs (older pm2-watchdog-*.log are removed). 0 = keep all.
KEEP_LOG_DAYS=30
# ======================================================================

DRY_RUN=0
VERBOSE=0
usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'pm2_watchdog.sh: unknown option %s (see --help)\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

# ---------- environment ----------
HOST="$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]')"
case "$HOST" in
  "$UAT_HOST_PREFIX"*)  ENVIRONMENT="UAT";   APP_DIR="$UAT_APP_DIR";   NODE_BIN_DIR="$UAT_NODE_BIN_DIR";   PM2_HOME_DIR="$UAT_PM2_HOME_DIR" ;;
  "$PROD_HOST_PREFIX"*) ENVIRONMENT="PROD";  APP_DIR="$PROD_APP_DIR";  NODE_BIN_DIR="$PROD_NODE_BIN_DIR";  PM2_HOME_DIR="$PROD_PM2_HOME_DIR" ;;
  *) printf 'pm2_watchdog.sh: host %s is not a UAT (%s*) or PROD (%s*) server: nothing to do\n' "$HOST" "$UAT_HOST_PREFIX" "$PROD_HOST_PREFIX" >&2; exit 1 ;;
esac

# ---------- folders, log ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$APP_DIR" ] || APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
LOG_FILE="$LOG_DIR/pm2-watchdog-$(date +%Y%m%d).log"
BUFFER=() # lines of this run; written to the log only when something happened (or --verbose)
note() { BUFFER+=("$(date '+%Y-%m-%d %H:%M:%S') $*"); if [ -t 1 ] || [ "$DRY_RUN" -eq 1 ]; then printf '%s\n' "$*"; fi; }
flush() { [ "$DRY_RUN" -eq 0 ] && [ ${#BUFFER[@]} -gt 0 ] && printf '%s\n' "${BUFFER[@]}" >> "$LOG_FILE" 2>/dev/null; BUFFER=(); } # --dry-run: screen only
fail() { note "ERROR: $*"; flush; exit 1; }

[ -f "$APP_DIR/ecosystem.config.js" ] || fail "ecosystem.config.js not found in $APP_DIR (set ${ENVIRONMENT}_APP_DIR in SETTINGS)"
[ "$DRY_RUN" -eq 1 ] && note "--dry-run: nothing will be changed"
[ "$VERBOSE" -eq 1 ] && note "$ENVIRONMENT (host $HOST): APP_DIR=$APP_DIR"

# Paused for maintenance
if [ -f "$APP_DIR/.pm2-watchdog-pause" ]; then
  [ "$VERBOSE" -eq 1 ] && { note "paused ($APP_DIR/.pm2-watchdog-pause exists): nothing checked"; flush; }
  exit 0
fi

# One run at a time (a slow start must not overlap the next cron run)
LOCK_DIR="${TMPDIR:-/tmp}/pm2-watchdog-$(id -u).lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # a lock older than 10 minutes is left over from a run that was killed: take it over
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else exit 0; fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------- node, npm, pm2 ----------
for d in "$NODE_BIN_DIR" /usr/local/bin /usr/bin /opt/node/bin "$HOME/.local/bin"; do
  [ -n "$d" ] && [ -d "$d" ] && PATH="$d:$PATH"
done
# nvm: the newest installed node
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$NVM_NODE" ] && PATH="$NVM_NODE:$PATH"
fi
export PATH
command -v node >/dev/null 2>&1 || fail "node not found (set ${ENVIRONMENT}_NODE_BIN_DIR in SETTINGS)"
NODE="$(command -v node)" # absolute path of node, used below
ECOSYSTEM="$APP_DIR/ecosystem.config.js"
command -v npm >/dev/null 2>&1 || note "warning: npm not found in PATH (not needed by the watchdog itself)"

PM2="$APP_DIR/node_modules/.bin/pm2" # pm2 comes with the project (root package.json)
[ -x "$PM2" ] || PM2="$(command -v pm2 2>/dev/null)"
[ -n "$PM2" ] && [ -x "$PM2" ] || fail "pm2 not found (run 'npm install' in $APP_DIR)"
[ -n "$PM2_HOME_DIR" ] && export PM2_HOME="$PM2_HOME_DIR"
PM2_HOME_USED="${PM2_HOME:-$HOME/.pm2}"
# every pm2 call: at most PM2_TIMEOUT seconds when `timeout` exists (Linux coreutils)
run_pm2() { if command -v timeout >/dev/null 2>&1; then timeout "$PM2_TIMEOUT" "$PM2" "$@"; else "$PM2" "$@"; fi; }
cd "$APP_DIR" || fail "cannot open $APP_DIR"

# ---------- 0. only one pm2 ----------
# Another pm2 of this user with a different home already runs (e.g. started by hand without PM2_HOME_DIR): starting
# the portal in this one too would clash on the same ports. Do nothing and log it until only one pm2 is left.
OTHER_PM2="$(ps -u "$(id -u)" -o args= 2>/dev/null | sed -n 's/.*PM2 v[0-9.]*: God Daemon (\(.*\))[[:space:]]*$/\1/p' | grep -vxF "$PM2_HOME_USED" | sort -u | tr '\n' ' ')"
if [ -n "$OTHER_PM2" ]; then
  note "another pm2 is running (home ${OTHER_PM2% }), this watchdog uses $PM2_HOME_USED: nothing done."
  note "keep one pm2: PM2_HOME=<other home> $PM2 kill, or set ${ENVIRONMENT}_PM2_HOME_DIR to that home"
  flush; exit 1
fi

# ---------- 1. pm2 itself ----------
pm2_alive() {
  local pid
  pid="$(cat "$PM2_HOME_USED/pm2.pid" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
STARTED=0
WOULD=0 # --dry-run: something would be started
if ! pm2_alive; then
  if [ "$DRY_RUN" -eq 1 ]; then
    note "pm2 is not running: would start it and then every app of ecosystem.config.js"
    WOULD=1
  else
    note "pm2 was not running (server restart?): starting it"
    run_pm2 ping >/dev/null 2>&1 || fail "pm2 could not be started"
    STARTED=1
  fi
fi

# ---------- 2. the apps ----------
# Apps this server should run (from ecosystem.config.js, which picks them by environment)
EXPECTED="$("$NODE" -e "process.stdout.write(require('$ECOSYSTEM').apps.map((a) => a.name).join(' '))" 2>/dev/null)"
[ -n "$EXPECTED" ] || fail "could not read the app names from ecosystem.config.js"

# Current pm2 status of each app: "name status" lines (nothing when pm2 is not running in --dry-run)
status_list() {
  pm2_alive || return 0
  run_pm2 jlist 2>/dev/null | "$NODE" -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = []; try { list = JSON.parse(s.slice(s.indexOf("["))); } catch { /* not JSON: none */ }
      list.forEach((p) => console.log(`${p.name} ${(p.pm2_env && p.pm2_env.status) || "unknown"}`));
    });'
}
status_of() { printf '%s\n' "$CURRENT" | awk -v n="$1" '$1 == n { print $2; exit }'; }

CURRENT="$(status_list)"
PROBLEM=0
for app in $EXPECTED; do
  st="$(status_of "$app")"
  case "$st" in
    online) [ "$VERBOSE" -eq 1 ] && note "$app: online" ;;
    launching) note "$app: still starting (launching): checked again next run" ;;
    "")
      if [ "$DRY_RUN" -eq 1 ]; then note "$app: not in pm2: would run pm2 start $ECOSYSTEM --only $app"; WOULD=1
      else
        note "$app: not in pm2: starting (pm2 start $ECOSYSTEM --only $app)"
        run_pm2 start "$ECOSYSTEM" --only "$app" >/dev/null 2>&1 || note "$app: pm2 start failed"
        STARTED=1
      fi ;;
    *)
      if [ "$DRY_RUN" -eq 1 ]; then note "$app: $st: would run pm2 restart $app"; WOULD=1
      else
        note "$app: $st: restarting (pm2 restart $app)"
        run_pm2 restart "$app" >/dev/null 2>&1 || note "$app: pm2 restart failed"
        STARTED=1
      fi ;;
  esac
done

# ---------- 3. check again, remember ----------
if [ "$STARTED" -eq 1 ]; then
  sleep "$WAIT_AFTER_START"
  CURRENT="$(status_list)"
  for app in $EXPECTED; do
    st="$(status_of "$app")"
    if [ "$st" = "online" ]; then note "$app: online"
    else note "$app: NOT online after starting (status: ${st:-missing}); see logs/pm2-* files"; PROBLEM=1; fi
  done
  run_pm2 save >/dev/null 2>&1 && note "pm2 save: app list remembered"
elif [ "$WOULD" -eq 0 ] && [ "$VERBOSE" -eq 1 ]; then
  note "all apps online: nothing to do"
fi

# ---------- old watchdog logs ----------
if [ "$KEEP_LOG_DAYS" -gt 0 ] 2>/dev/null && [ "$DRY_RUN" -eq 0 ]; then
  find "$LOG_DIR" -maxdepth 1 -name 'pm2-watchdog-*.log' -mtime +"$KEEP_LOG_DAYS" -delete 2>/dev/null
fi

flush
exit $([ "$PROBLEM" -eq 1 ] && echo 2 || echo 0)
