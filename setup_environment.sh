#!/usr/bin/env bash
#
# setup_environment.sh - set up the SRE / CBGM Portal on a new UAT or PROD server (Linux), or check an existing one.
#
#   scripts/standalone/setup_environment.sh [options]
#
# Steps (each prints OK / WARN / FAIL; the run stops at the first FAIL that blocks the next step):
#    1. environment from the hostname (same rule as backend/src/config/config.js): x01s* = UAT, x01g* = PROD
#    2. tools: node (24), npm, openssl, curl
#   The code must already be in APP_DIR (e.g. copied there by deploy.sh): this script does not get or update it.
#    3. folders: logs, Attachment, Input, Reports and ssl - every folder this script creates gets permission 775;
#       the certificate files from SSL_CER / SSL_KEY / SSL_CHAIN (SETTINGS) are copied into ssl/
#    4. backend/src/config/config.js (put on the server by you, with every setting for this environment) is checked:
#       environment, jwtSecret, database, LDAP, HTTPS files, CBGM / Tier-2 settings (no secret is printed)
#    5. certificates in ssl/ (the files named in config.js https certFile / keyFile / caFile - each server has its
#       own names): permission CERT_MODE (SETTINGS, 775), expiry date
#    6. network: database and LDAP servers reachable (TCP)
#    7. packages: npm install in the root, backend and frontend (as npm run install:all; pm2 included: it is a package
#       of the root package.json) from this environment's registry (NPM_REGISTRY, e.g. JFrog; NPM_TRUSTED_HOST when
#       its certificate is not trusted); a folder whose install fails gets its packages one by one
#       (npm --prefix <folder> install <package>@<version>); then a frontend build - only when
#       node_modules or pm2 is missing, or a package.json / package-lock.json of the root, backend or frontend changed
#       since the last install on this server (otherwise skipped). No global pm2 is needed.
#    8. pm2: start the portal apps that are not running (online ones are left running unless --restart), check
#       they are online, pm2 save; the command that starts pm2 at boot is shown (it needs sudo, so it is not run)
#    9. health: https://<this server's full name, or HEALTH_HOST>:<web port>/api/health answers {"status":"ok"}
#   10. pm2 watchdog in cron (scripts/standalone/pm2_watchdog.sh every 5 minutes + at reboot): asked first
#   Safe to run again on a set-up server: existing folders, files and cron lines are kept, nothing is restarted
#   (unless --restart, or new packages were installed: then the apps are restarted to load them); step 7 installs
#   only when a package file changed.
#
# Options:
#   -c, --check          checks only (steps 1-6 and 9): nothing is installed, started or changed (no folders, no
#                        chmod)
#   -y, --yes            do not ask: add the watchdog to cron
#       --skip-install   never install in step 7 (it only reports when an install is needed)
#       --restart        step 8: also restart apps that are already online (normally they are left running, so a
#                        second run of this script on a set-up server causes no downtime)
#       --no-cron        never touch cron (step 10 only prints the lines)
#   -h, --help           show this help
#
# Run it as the user that runs the portal (the one that owns pm2), from anywhere:
#   /opt/incident-portal/scripts/standalone/setup_environment.sh --check     see what is missing
#   /opt/incident-portal/scripts/standalone/setup_environment.sh             set up / repair
# A log of the run: <APP_DIR>/logs/setup-YYYYMMDD-HHMMSS.log
#
# Exit codes: 0 done (warnings may be listed), 1 a step failed (see the FAIL lines), 2 bad option / not UAT or PROD

set -u
set -o pipefail

# ============================== SETTINGS ==============================
# Environment by hostname, the same rule as backend/src/config/config.js
UAT_HOST_PREFIX="x01s"
PROD_HOST_PREFIX="x01g"

# Per environment:
#   APP_DIR       the portal folder (the one with ecosystem.config.js); "" = two folders above this script
#   NODE_BIN_DIR  folder that holds node and npm; "" = the node already in PATH (or the usual places)
#   PM2_HOME_DIR  pm2's home folder; "" = ~/.pm2 of the user running this script
#   NPM_REGISTRY  npm registry for the packages (e.g. that environment's JFrog URL); "" = npm's own setting (~/.npmrc)
#   NPM_TRUSTED_HOST  the registry's host name when its HTTPS certificate is not trusted by this server (e.g. an
#                 internal certificate): npm then does not check the certificate (npm has no trusted-host setting;
#                 this uses strict-ssl=false for this script's npm calls only, ~/.npmrc is not changed). "" = check it
#   HEALTH_HOST   host name for the health check (step 9): "" = this server's full name (hostname -f), the address
#                 users open; set it to check another name, e.g. the GTM / DNS name of PROD
#   SSL_CER / SSL_KEY / SSL_CHAIN  full paths of this environment's certificate, private key and chain certificate
#                 on the server, only when they are kept outside <APP_DIR>/ssl: step 3 copies them into ssl/ under
#                 the names in this server's config.js https certFile / keyFile / caFile. "" = nothing to copy
UAT_APP_DIR="/CBGM/SREPORTAL"           # the portal folder (also the user's home folder)
UAT_NODE_BIN_DIR=""     # e.g. "/opt/node-v24.11.0-linux-x64/bin"
UAT_PM2_HOME_DIR="/CBGM/SREPORTAL/.pm2"  # pm2's home (~/.pm2 of the portal user)
UAT_NPM_REGISTRY=""     # e.g. "https://jfrog-uat.example.com/artifactory/api/npm/npm-remote/"
UAT_NPM_TRUSTED_HOST="" # e.g. "jfrog-uat.example.com"
UAT_HEALTH_HOST=""      # "" = this server's full name
# Certificates are kept in /CBGM/SREPORTAL/ssl (the portal's own ssl/ folder), so nothing is copied: leave these
# empty. The file names differ per server: they are the names in that server's config.js https certFile / keyFile /
# caFile (the script reads them from there).
UAT_SSL_CER=""          # only if the files are elsewhere, e.g. "/path/to/uat/certificate.cer"
UAT_SSL_KEY=""          # e.g. "/path/to/uat/private.key"
UAT_SSL_CHAIN=""        # e.g. "/path/to/uat/chain.cer"   (optional)

PROD_APP_DIR="/CBGM/SREPORTAL"          # the portal folder (also the user's home folder)
PROD_NODE_BIN_DIR=""    # e.g. "/opt/node-v24.11.0-linux-x64/bin"
PROD_PM2_HOME_DIR="/CBGM/SREPORTAL/.pm2" # pm2's home (~/.pm2 of the portal user)
PROD_NPM_REGISTRY=""    # e.g. "https://jfrog-prod.example.com/artifactory/api/npm/npm-remote/"
PROD_NPM_TRUSTED_HOST="" # e.g. "jfrog-prod.example.com"
PROD_HEALTH_HOST=""     # "" = this server's full name (or e.g. the GTM name)
PROD_SSL_CER=""         # leave empty: certificates are in /CBGM/SREPORTAL/ssl (see UAT above)
PROD_SSL_KEY=""
PROD_SSL_CHAIN=""

# Permission of the certificate files in ssl/ (config.js https certFile / keyFile / caFile), set on every run.
# Note: 775 lets every user on the server read the private key (keyFile); 600 = only the portal user.
CERT_MODE="775"

# Node major version the portal is built and tested on (older than NODE_MIN_MAJOR = FAIL, other = WARN)
NODE_MAJOR=24
NODE_MIN_MAJOR=18

# Seconds to wait for the portal to answer /api/health after pm2 starts it
HEALTH_WAIT=60
# ======================================================================

CHECK_ONLY=0
ASSUME_YES=0
SKIP_INSTALL=0
RESTART=0
NO_CRON=0
usage() { sed -n '2,/^# Exit codes/p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    -c|--check) CHECK_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --restart) RESTART=1 ;;
    --no-cron) NO_CRON=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'setup_environment.sh: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---------- output ----------
FAILS=0
WARNS=()
LOG_FILE=""
out() { printf '%s\n' "$*"; [ -n "$LOG_FILE" ] && printf '%s\n' "$*" >> "$LOG_FILE" 2>/dev/null; return 0; }
step() { out ""; out "== $* =="; }
ok() { out "  [OK]   $*"; }
info() { out "  [..]   $*"; }
warn() { out "  [WARN] $*"; WARNS+=("$*"); }
fail() { out "  [FAIL] $*"; FAILS=$((FAILS + 1)); }
todo() { out "         -> $*"; }
stop_if_failed() { # end the run when a step failed that the next steps need
  [ "$FAILS" -eq 0 ] && return 0
  out ""; out "Stopped: $FAILS problem(s) above (FAIL) must be fixed first, then run this script again."
  exit 1
}
ask() { # ask "question" -> 0 = yes
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ -t 0 ] || return 1
  local a; read -r -p "  $1 [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ]
}

# ---------- 1. environment ----------
HOST="$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]')"
case "$HOST" in
  "$UAT_HOST_PREFIX"*)  ENVIRONMENT="UAT";  APP_DIR="$UAT_APP_DIR";  NODE_BIN_DIR="$UAT_NODE_BIN_DIR";  PM2_HOME_DIR="$UAT_PM2_HOME_DIR";  NPM_REGISTRY="$UAT_NPM_REGISTRY"; NPM_TRUSTED_HOST="$UAT_NPM_TRUSTED_HOST"; HEALTH_HOST="$UAT_HEALTH_HOST"
                        SSL_CER="$UAT_SSL_CER";  SSL_KEY="$UAT_SSL_KEY";  SSL_CHAIN="$UAT_SSL_CHAIN" ;;
  "$PROD_HOST_PREFIX"*) ENVIRONMENT="PROD"; APP_DIR="$PROD_APP_DIR"; NODE_BIN_DIR="$PROD_NODE_BIN_DIR"; PM2_HOME_DIR="$PROD_PM2_HOME_DIR"; NPM_REGISTRY="$PROD_NPM_REGISTRY"; NPM_TRUSTED_HOST="$PROD_NPM_TRUSTED_HOST"; HEALTH_HOST="$PROD_HEALTH_HOST"
                        SSL_CER="$PROD_SSL_CER"; SSL_KEY="$PROD_SSL_KEY"; SSL_CHAIN="$PROD_SSL_CHAIN" ;;
  *) printf 'setup_environment.sh: host %s is not a UAT (%s*) or PROD (%s*) server: nothing to do\n' "$HOST" "$UAT_HOST_PREFIX" "$PROD_HOST_PREFIX" >&2; exit 2 ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$APP_DIR" ] || APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ "$CHECK_ONLY" -eq 0 ] && [ ! -d "$APP_DIR/logs" ] && mkdir -p "$APP_DIR/logs" 2>/dev/null; then chmod 775 "$APP_DIR/logs" 2>/dev/null; fi
if [ "$CHECK_ONLY" -eq 0 ] && [ -d "$APP_DIR/logs" ]; then LOG_FILE="$APP_DIR/logs/setup-$(date +%Y%m%d-%H%M%S).log"; fi

out "SRE / CBGM Portal setup - $(date '+%Y-%m-%d %H:%M:%S')"
step "1. Environment"
ok "$ENVIRONMENT (host $HOST), user $(id -un)"
[ "$CHECK_ONLY" -eq 1 ] && info "--check: nothing will be installed, started or changed"
if [ -f "$APP_DIR/ecosystem.config.js" ] && [ -f "$APP_DIR/package.json" ]; then ok "portal folder $APP_DIR"
else
  fail "no portal code in $APP_DIR (ecosystem.config.js / package.json missing)"
  todo "set ${ENVIRONMENT}_APP_DIR in SETTINGS, or copy the portal code into $APP_DIR first"
fi
[ "$(id -u)" -eq 0 ] && warn "running as root: run it as the user that runs the portal (pm2 and its files belong to that user)"
stop_if_failed
cd "$APP_DIR" || exit 1
# Everything below uses absolute paths (portal folder, config.js, ecosystem.config.js, node, npm, pm2)
CONFIG_JS="$APP_DIR/backend/src/config/config.js"
ECOSYSTEM="$APP_DIR/ecosystem.config.js"
SSL_DIR="$APP_DIR/ssl"

# ---------- 2. tools ----------
step "2. Tools"
[ -n "$NODE_BIN_DIR" ] && PATH="$NODE_BIN_DIR:$PATH"
for d in /usr/local/bin /usr/bin; do PATH="$PATH:$d"; done
export PATH
NODE="$(command -v node 2>/dev/null)"; NPM="$(command -v npm 2>/dev/null)" # absolute paths of the programs used below
if [ -n "$NODE" ]; then
  NODE_V="$("$NODE" -v 2>/dev/null)"; NODE_M="${NODE_V#v}"; NODE_M="${NODE_M%%.*}"
  if [ "$NODE_M" -lt "$NODE_MIN_MAJOR" ] 2>/dev/null; then fail "node $NODE_V is too old (needs $NODE_MIN_MAJOR or newer, built on $NODE_MAJOR)"
  elif [ "$NODE_M" != "$NODE_MAJOR" ]; then warn "node $NODE_V ($NODE): the portal is built and tested on Node $NODE_MAJOR"
  else ok "node $NODE_V ($NODE)"; fi
else
  fail "node not found"; todo "install Node $NODE_MAJOR, or set ${ENVIRONMENT}_NODE_BIN_DIR in SETTINGS"
fi
if [ -n "$NPM" ]; then
  ok "npm $("$NPM" -v 2>/dev/null) ($NPM)"
  # npm settings for this script's npm calls only (environment variables; ~/.npmrc is not changed)
  if [ -n "$NPM_REGISTRY" ]; then
    export npm_config_registry="$NPM_REGISTRY"
    # package-lock.json keeps each package's download address from the machine that made it (often
    # registry.npmjs.org): always: fetch them from this registry instead
    export npm_config_replace_registry_host=always
    ok "npm registry (${ENVIRONMENT}_NPM_REGISTRY): $NPM_REGISTRY (also for the addresses in package-lock.json)"
  else info "npm registry: npm's own setting ($("$NPM" config get registry 2>/dev/null))"; fi
  if [ -n "$NPM_TRUSTED_HOST" ]; then
    export npm_config_strict_ssl=false
    ok "trusted host (${ENVIRONMENT}_NPM_TRUSTED_HOST): $NPM_TRUSTED_HOST - its HTTPS certificate is not checked"
    case "$NPM_REGISTRY" in *"$NPM_TRUSTED_HOST"*|"") ;; *) warn "${ENVIRONMENT}_NPM_TRUSTED_HOST $NPM_TRUSTED_HOST is not the host of ${ENVIRONMENT}_NPM_REGISTRY" ;; esac
  fi
else fail "npm not found (comes with node)"; fi
for t in openssl curl; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t"; else warn "$t not found (needed for: openssl = certificate check / jwtSecret, curl = health check)"; fi
done
[ -n "$PM2_HOME_DIR" ] && export PM2_HOME="$PM2_HOME_DIR"
stop_if_failed

# ---------- 3. folders ----------
step "3. Folders"
for d in logs Attachment Input Reports ssl; do
  if [ -d "$APP_DIR/$d" ]; then ok "$APP_DIR/$d"
  elif [ "$CHECK_ONLY" -eq 1 ]; then warn "$APP_DIR/$d missing (created by a normal run)"
  elif mkdir -p "$APP_DIR/$d" && chmod 775 "$APP_DIR/$d"; then ok "$APP_DIR/$d created (775)"
  else fail "cannot create $APP_DIR/$d"; fi
done
# Certificate files from the paths in SETTINGS (${ENVIRONMENT}_SSL_CER / _KEY / _CHAIN) into ssl/: copied when missing
# there or different (cmp); every file gets CERT_MODE (775)
copy_ssl() { # copy_ssl <source path> <name in ssl/> <setting name> <required 1|0> <mode>
  local src="$1" name="$2" setting="$3" req="$4" mode="$5"
  if [ -z "$src" ]; then return 0; fi
  if [ ! -f "$src" ]; then
    if [ "$req" -eq 1 ]; then fail "$setting: $src not found"; else warn "$setting: $src not found (optional)"; fi
    return 0
  fi
  local dst="$SSL_DIR/$name"
  # the path already points at that file in ssl/ itself: nothing to copy
  if [ -f "$dst" ] && [ "$(cd "$(dirname "$src")" && pwd -P)/$(basename "$src")" = "$(cd "$SSL_DIR" && pwd -P)/$name" ]; then ok "$dst already in place ($setting)"; return 0; fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$dst up to date ($setting)"; return 0; fi
  if [ "$CHECK_ONLY" -eq 1 ]; then warn "$dst would be copied from $src ($setting)"; return 0; fi
  if cp "$src" "$dst" && chmod "$mode" "$dst"; then ok "$dst copied from $src ($mode)"
  else fail "cannot copy $src to $dst"; fi
}
# File names of this server's certificates: config.js https certFile / keyFile / caFile (they differ per server)
https_file() { "$NODE" -e "process.stdout.write(String((require('$CONFIG_JS').https || {})['$1'] || ''))" 2>/dev/null; }
ssl_name() { local p; p="$(https_file "$1")"; [ -n "$p" ] && basename "$p" || echo "$2"; } # name in ssl/, or "$2" when unknown
if [ -d "$SSL_DIR" ] && { [ -n "$SSL_CER" ] || [ -n "$SSL_KEY" ] || [ -n "$SSL_CHAIN" ]; }; then
  copy_ssl "$SSL_CER" "$(ssl_name certFile "$(basename "${SSL_CER:-x}")")" "${ENVIRONMENT}_SSL_CER" 1 "$CERT_MODE"
  copy_ssl "$SSL_KEY" "$(ssl_name keyFile "$(basename "${SSL_KEY:-x}")")" "${ENVIRONMENT}_SSL_KEY" 1 "$CERT_MODE"
  copy_ssl "$SSL_CHAIN" "$(ssl_name caFile "$(basename "${SSL_CHAIN:-x}")")" "${ENVIRONMENT}_SSL_CHAIN" 0 "$CERT_MODE"
fi
# A new (or empty) ssl/ needs this server's certificate files before the portal can start (HTTPS)
if [ -d "$SSL_DIR" ] && [ -z "$(ls -A "$SSL_DIR" 2>/dev/null)" ]; then
  warn "$SSL_DIR is empty: put this server's certificate files into $SSL_DIR (or set ${ENVIRONMENT}_SSL_CER / _KEY / _CHAIN)"
  todo "certificate, private key and chain (optional) - named as in this server's config.js https certFile /"
  todo "keyFile / caFile, e.g. cp /path/to/<certificate>.cer $SSL_DIR/"
fi

# ---------- 4. config.js ----------
step "4. Configuration (backend/src/config/config.js)"
CONFIG="$CONFIG_JS"
if [ ! -f "$CONFIG" ]; then
  fail "$CONFIG is missing"
  todo "put this server's config.js there, with the $ENVIRONMENT settings filled in (database, LDAP, auth.jwtSecret,"
  todo "https files, CBGMAlertReviewer, MTJ_tier2_review, ...), then run this script again"
  stop_if_failed
fi
# Checked by node: prints "OK|WARN|FAIL<TAB>message" lines, never a secret
CONFIG_REPORT="$(CONFIG_JS="$CONFIG_JS" ENV_EXPECTED="$ENVIRONMENT" "$NODE" - <<'NODE' 2>&1
const fs = require('fs');
const say = (k, m) => console.log(`${k}\t${m}`);
let c;
try { c = require(process.env.CONFIG_JS); }
catch (e) { say('FAIL', `config.js does not load: ${String(e.message).split('\n')[0]}`); process.exit(0); }
const set = (v) => v !== undefined && v !== null && String(v).trim() !== '';
if (c.environment !== process.env.ENV_EXPECTED) say('FAIL', `config.js chose environment ${c.environment}, this host is ${process.env.ENV_EXPECTED}`);
else say('OK', `environment ${c.environment}`);
const jwt = (c.auth && c.auth.jwtSecret) || '';
say(jwt.length >= 32 ? 'OK' : 'WARN', jwt.length >= 32 ? 'auth.jwtSecret set' : 'auth.jwtSecret is short: use openssl rand -hex 64');
const db = c.db || {};
const dbMissing = ['host', 'user', 'password', 'database'].filter((k) => !set(db[k]));
say(dbMissing.length ? 'FAIL' : 'OK', dbMissing.length ? `db: empty ${dbMissing.join(', ')}` : `db ${db.host}:${db.port || 3306} / ${db.database} as ${db.user}`);
const ldap = (c.ldap && c.ldap.servers) || [];
if (!ldap.length) say('FAIL', 'ldap: no servers');
ldap.forEach((s) => {
  const miss = ['host', 'baseDN'].filter((k) => !set(s[k])).concat(set(s.serviceDN) && !set(s.servicePassword) ? ['servicePassword'] : []);
  say(miss.length ? 'FAIL' : 'OK', miss.length ? `ldap ${s.name || '?'}: empty ${miss.join(', ')}` : `ldap ${s.name || '?'} ${s.host}:${s.port || 636}`);
});
const h = c.https;
if (!h) say('FAIL', 'https block missing (UAT / PROD need HTTPS)');
else {
  [['certFile', true], ['keyFile', true], ['caFile', false]].forEach(([k, req]) => {
    if (!set(h[k])) { if (req) say('FAIL', `https.${k} is empty`); return; }
    const there = fs.existsSync(h[k]);
    say(there ? 'OK' : req ? 'FAIL' : 'WARN', `https.${k} ${h[k]}${there ? '' : ' - file not found: copy it into the ssl/ folder'}`);
  });
}
const list = (k, what) => { const v = c[k]; say(Array.isArray(v) && v.length ? 'OK' : 'WARN', Array.isArray(v) && v.length ? `${k}: ${v.length} ${what}` : `${k} is empty: ${what} cannot work`); };
list('CBGMAlertReviewer', 'CBGM Team reviewer(s) of Onboard New Alerts');
list('MTJ_tier2_review', 'Tier-2 Journey approver(s)');
if (!set(c.MTJ_tier2_healthIdPrefix)) say('WARN', 'MTJ_tier2_healthIdPrefix not set (HCA_ is used)');
if (!c.chooseColor) say('WARN', 'chooseColor not set (default red colours are used)');
if (c.environment === 'PROD' && c.mail && set(c.mail.sendmailPath) && !fs.existsSync(c.mail.sendmailPath)) say('WARN', `mail.sendmailPath ${c.mail.sendmailPath} not found: PROD emails cannot be sent`);
NODE
)"
while IFS=$'\t' read -r kind msg; do
  [ -z "$kind" ] && continue
  case "$kind" in OK) ok "$msg" ;; WARN) warn "$msg" ;; FAIL) fail "$msg" ;; *) fail "$kind $msg" ;; esac
done <<< "$CONFIG_REPORT"
[ "$CHECK_ONLY" -eq 0 ] && chmod 640 "$CONFIG" 2>/dev/null
stop_if_failed

# ---------- 5. certificates ----------
step "5. Certificates (ssl/)"
CERT_FILE="$(https_file certFile)"
# every certificate file (certificate, private key, chain) gets CERT_MODE
for F in "$CERT_FILE" "$(https_file keyFile)" "$(https_file caFile)"; do
  [ -n "$F" ] && [ -f "$F" ] || continue
  if [ "$CHECK_ONLY" -eq 0 ]; then chmod "$CERT_MODE" "$F" && ok "$(basename "$F") permission $CERT_MODE"
  else ok "$(basename "$F") (permission $(stat -c %a "$F" 2>/dev/null || stat -f %Lp "$F" 2>/dev/null || echo '?'))"; fi
done
if [ -n "$CERT_FILE" ] && [ -f "$CERT_FILE" ] && command -v openssl >/dev/null 2>&1; then
  END="$(openssl x509 -enddate -noout -in "$CERT_FILE" 2>/dev/null | cut -d= -f2)"
  if [ -n "$END" ]; then
    if openssl x509 -checkend $((30 * 86400)) -noout -in "$CERT_FILE" >/dev/null 2>&1; then ok "certificate valid until $END"
    else warn "certificate expires within 30 days (or has expired): $END"; fi
  else warn "$(basename "$CERT_FILE") could not be read as a certificate"; fi
fi

# ---------- 6. network ----------
step "6. Network (TCP)"
NET_REPORT="$(CONFIG_JS="$CONFIG_JS" "$NODE" - <<'NODE' 2>&1
const net = require('net');
const c = require(process.env.CONFIG_JS);
const targets = [[`database ${c.db.host}:${c.db.port || 3306}`, c.db.host, c.db.port || 3306]]
  .concat(((c.ldap && c.ldap.servers) || []).filter((s) => s.host).map((s) => [`LDAP ${s.name || ''} ${s.host}:${s.port || 636}`, s.host, s.port || 636]));
Promise.all(targets.map(([label, host, port]) => new Promise((done) => {
  const sock = net.connect({ host, port, timeout: 5000 });
  const end = (k, m) => { sock.destroy(); done(`${k}\t${label}${m}`); };
  sock.on('connect', () => end('OK', ''));
  sock.on('timeout', () => end('WARN', ' - no answer in 5 s'));
  sock.on('error', (e) => end('WARN', ` - ${e.code || e.message}`));
}))).then((lines) => { console.log(lines.join('\n')); process.exit(0); });
NODE
)"
while IFS=$'\t' read -r kind msg; do
  [ -z "$kind" ] && continue
  case "$kind" in OK) ok "$msg reachable" ;; *) warn "$msg (check the firewall)" ;; esac
done <<< "$NET_REPORT"

# ---------- 7. packages ----------
# Installed (from this environment's registry, e.g. JFrog) only when needed: node_modules missing in the root, backend
# or frontend, or a package.json / package-lock.json there changed since the last install here. The last install is
# remembered as a checksum of those 6 files in node_modules/.portal-packages.sum.
step "7. Packages"
PKG_FILES="package.json package-lock.json backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json"
PKG_STAMP="$APP_DIR/node_modules/.portal-packages.sum"
pkg_sum() { for f in $PKG_FILES; do if [ -f "$APP_DIR/$f" ]; then printf '%s %s\n' "$f" "$(cksum < "$APP_DIR/$f")"; else printf '%s missing\n' "$f"; fi; done; }
PKG_REASON=""
for d in . backend frontend; do [ -d "$APP_DIR/$d/node_modules" ] || PKG_REASON="${PKG_REASON:+$PKG_REASON; }node_modules missing in $([ "$d" = . ] && echo root || echo "$d")"; done
# pm2 is a package of the project (root package.json), installed from the same registry: missing = install
[ -d "$APP_DIR/node_modules" ] && [ ! -x "$APP_DIR/node_modules/.bin/pm2" ] && PKG_REASON="${PKG_REASON:+$PKG_REASON; }pm2 missing in node_modules"
if [ -z "$PKG_REASON" ]; then
  if [ ! -f "$PKG_STAMP" ]; then PKG_REASON="no record of the last install here"
  elif [ "$(pkg_sum)" != "$(cat "$PKG_STAMP")" ]; then
    CHANGED="$(pkg_sum | diff - "$PKG_STAMP" 2>/dev/null | awk '/^[<>]/ { print $2 }' | sort -u | tr '\n' ' ')"
    PKG_REASON="changed since the last install: ${CHANGED% }"
  fi
fi
PACKAGES_CHANGED=0
if [ -z "$PKG_REASON" ]; then ok "packages up to date (package.json / package-lock.json unchanged since the last install)"
elif [ "$CHECK_ONLY" -eq 1 ]; then warn "packages need installing: $PKG_REASON"
elif [ "$SKIP_INSTALL" -eq 1 ]; then warn "packages need installing ($PKG_REASON) but --skip-install was given"
else
  info "install needed: $PKG_REASON"
  if [ -n "$NPM_REGISTRY" ]; then info "from registry $NPM_REGISTRY (${ENVIRONMENT}_NPM_REGISTRY)"
  else warn "${ENVIRONMENT}_NPM_REGISTRY is empty: installing from npm's own setting ($("$NPM" config get registry 2>/dev/null))"; fi
  # Same as npm run install:all (root, backend, frontend), one folder at a time. When a folder's install fails, its
  # packages (package.json dependencies + devDependencies) are installed one by one:
  #   npm --prefix <folder> install <package>@<version in package.json> --no-save
  # (the version from package.json, and --no-save, so package.json / package-lock.json stay as they are), then
  # npm --prefix <folder> install once more for the rest.
  install_folder() { # install_folder <folder> <label>
    local dir="$1" label="$2" p failed=0 failed_list="" total=0
    info "$NPM --prefix $dir install ($label) ..."
    if "$NPM" --prefix "$dir" install >> "${LOG_FILE:-/dev/null}" 2>&1; then ok "$label packages installed"; return 0; fi
    warn "$label: npm install failed - installing its packages one by one (npm --prefix $dir install <package>)"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      total=$((total + 1))
      if "$NPM" --prefix "$dir" install "$p" --no-save >> "${LOG_FILE:-/dev/null}" 2>&1; then info "  installed $p"
      else failed=$((failed + 1)); failed_list="$failed_list $p"; out "  [FAIL]   $p"; fi
    done <<< "$("$NODE" -e "const p = require('$dir/package.json'); Object.entries({ ...(p.dependencies || {}), ...(p.devDependencies || {}) }).forEach(([n, v]) => console.log(n + '@' + v))" 2>/dev/null)"
    if [ "$failed" -gt 0 ]; then
      fail "$label: $failed of $total package(s) could not be installed:$failed_list (see ${LOG_FILE:-the output})"
      todo "check that ${NPM_REGISTRY:-the registry} has them, or try: $NPM --prefix $dir install <package>"
      return 1
    fi
    # every package went in one by one: one more full install fills in what they need
    if "$NPM" --prefix "$dir" install >> "${LOG_FILE:-/dev/null}" 2>&1; then ok "$label packages installed ($total one by one, then npm install)"
    else ok "$label: all $total packages installed one by one"; warn "$label: the npm install after them still reports an error (see ${LOG_FILE:-the output})"; fi
    return 0
  }
  INSTALL_OK=1
  install_folder "$APP_DIR" "root (pm2)" || INSTALL_OK=0
  install_folder "$APP_DIR/backend" "backend" || INSTALL_OK=0
  install_folder "$APP_DIR/frontend" "frontend" || INSTALL_OK=0
  if [ "$INSTALL_OK" -eq 1 ]; then
    pkg_sum > "$PKG_STAMP"; PACKAGES_CHANGED=1
    if [ -x "$APP_DIR/node_modules/.bin/pm2" ]; then ok "pm2 $("$NODE" -p "require('$APP_DIR/node_modules/pm2/package.json').version" 2>/dev/null) installed (root package.json) from $("$NPM" config get registry 2>/dev/null)"
    else fail "pm2 was not installed: check that the registry has the pm2 package (root package.json)"; fi
  fi
  stop_if_failed
  info "$NPM --prefix $APP_DIR run build (frontend) ..."
  if "$NPM" --prefix "$APP_DIR" run build >> "${LOG_FILE:-/dev/null}" 2>&1; then ok "frontend built ($APP_DIR/frontend/dist)"
  else fail "npm run build failed (see ${LOG_FILE:-the output})"; fi
fi
stop_if_failed

# ---------- 8. pm2 ----------
step "8. pm2"
PM2="$APP_DIR/node_modules/.bin/pm2"
if [ ! -x "$PM2" ]; then
  if [ "$CHECK_ONLY" -eq 1 ]; then warn "pm2 not installed yet (comes with npm run install:all)"; else fail "pm2 not found in node_modules (npm run install:all)"; fi
else
  APPS="$("$NODE" -e "process.stdout.write(require('$ECOSYSTEM').apps.map((a) => a.name).join(' '))" 2>/dev/null)"
  pm2_status() { "$PM2" jlist 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let l=[];try{l=JSON.parse(s.slice(s.indexOf("[")))}catch{}l.forEach((p)=>console.log(p.name+" "+((p.pm2_env&&p.pm2_env.status)||"?")))})'; }
  status_of() { printf '%s\n' "$STATUS" | awk -v n="$1" '$1 == n { print $2; exit }'; }
  if [ "$CHECK_ONLY" -eq 0 ]; then
    # Running again on a set-up server: apps already online are left running (no downtime) unless --restart;
    # missing apps are started, stopped / errored ones restarted
    STATUS="$(pm2_status)"; STARTED=0
    for app in $APPS; do
      st="$(status_of "$app")"
      if [ "$st" = "online" ] && [ "$RESTART" -eq 0 ] && [ "$PACKAGES_CHANGED" -eq 1 ]; then
        # new packages are loaded only when the app starts again
        if "$PM2" restart "$app" >> "${LOG_FILE:-/dev/null}" 2>&1; then ok "$app restarted to load the new packages"; STARTED=1; else fail "pm2 could not restart $app"; fi
      elif [ "$st" = "online" ] && [ "$RESTART" -eq 0 ]; then info "$app already online: left running (--restart to restart it)"
      elif [ -z "$st" ]; then
        if "$PM2" start "$ECOSYSTEM" --only "$app" >> "${LOG_FILE:-/dev/null}" 2>&1; then ok "$app started"; STARTED=1; else fail "pm2 could not start $app"; fi
      else
        if "$PM2" restart "$app" >> "${LOG_FILE:-/dev/null}" 2>&1; then ok "$app restarted (was $st)"; STARTED=1; else fail "pm2 could not restart $app"; fi
      fi
    done
    [ "$STARTED" -eq 1 ] && sleep 8
  fi
  # --check must not start pm2: ask it only when its daemon is already running
  PM2_PID="$(cat "${PM2_HOME:-$HOME/.pm2}/pm2.pid" 2>/dev/null)"
  if [ "$CHECK_ONLY" -eq 1 ] && ! { [ -n "$PM2_PID" ] && kill -0 "$PM2_PID" 2>/dev/null; }; then STATUS=""; warn "pm2 is not running"
  else STATUS="$(pm2_status)"; fi
  for app in $APPS; do
    st="$(status_of "$app")"
    if [ "$st" = "online" ]; then ok "$app online"
    elif [ "$CHECK_ONLY" -eq 1 ]; then warn "$app ${st:-not in pm2}"
    else fail "$app ${st:-not in pm2}: see logs/pm2-* files"; fi
  done
  if [ "$CHECK_ONLY" -eq 0 ] && [ "$FAILS" -eq 0 ]; then "$PM2" save >/dev/null 2>&1 && ok "pm2 save: app list remembered"; fi
  # Start at boot: pm2 prints a sudo command; it is shown, not run
  if ls /etc/systemd/system/pm2-"$(id -un)".service >/dev/null 2>&1; then ok "pm2 starts at boot (systemd pm2-$(id -un))"
  else
    warn "pm2 is not set to start at boot"
    STARTUP=""
    [ "$CHECK_ONLY" -eq 0 ] && STARTUP="$("$PM2" startup 2>/dev/null | grep -m1 '^sudo ')"
    if [ -n "$STARTUP" ]; then todo "run once (needs sudo): $STARTUP"; else todo "run: $PM2 startup   and then the sudo line it prints"; fi
  fi
fi
stop_if_failed

# ---------- 9. health ----------
# https://<HEALTH_HOST, default this server's full name>:<web port>/api/health must answer {"status":"ok"}.
# --noproxy '*': a proxy setting (https_proxy) must not catch this request. -k for the answer itself (the certificate
# is checked separately, as a warning: it may be made out to another name, e.g. the GTM name).
step "9. Health"
WEB_PORT="$("$NODE" -e "process.stdout.write(String(require('$CONFIG_JS').ports.web || 60443))" 2>/dev/null)"
CHECK_HOST="${HEALTH_HOST:-$(hostname -f 2>/dev/null || hostname)}"
URL="https://$CHECK_HOST:${WEB_PORT:-60443}/api/health"
health() { curl -ks --noproxy '*' --max-time 5 "$1" 2>/dev/null; }
if command -v curl >/dev/null 2>&1; then
  WAITED=0; ANSWER=""
  while [ "$WAITED" -lt "$HEALTH_WAIT" ]; do
    ANSWER="$(health "$URL")"
    printf '%s' "$ANSWER" | grep -q '"ok"' && break
    [ "$CHECK_ONLY" -eq 1 ] && break
    sleep 5; WAITED=$((WAITED + 5))
  done
  if printf '%s' "$ANSWER" | grep -q '"ok"'; then
    ok "$URL answers $ANSWER"
    if curl -s --noproxy '*' --max-time 5 -o /dev/null "$URL" 2>/dev/null; then ok "certificate accepted for $CHECK_HOST"
    else warn "the certificate is not accepted for $CHECK_HOST (made out to another name, or this server lacks the CA): users may see a warning"; fi
  elif [ "$CHECK_ONLY" -eq 1 ]; then warn "$URL does not answer (portal not running, or $CHECK_HOST not resolvable here)"
  else
    fail "$URL does not answer after ${HEALTH_WAIT}s"
    todo "is the portal running? $PM2 logs  - and does $CHECK_HOST resolve on this server? (set ${ENVIRONMENT}_HEALTH_HOST)"
  fi
else warn "curl not found: open $URL yourself"; fi

# ---------- 10. watchdog ----------
step "10. pm2 watchdog (cron)"
WATCHDOG="$APP_DIR/scripts/standalone/pm2_watchdog.sh"
CRON_LINES="*/5 * * * * $WATCHDOG >/dev/null 2>&1
@reboot sleep 60 && $WATCHDOG >/dev/null 2>&1"
if [ ! -f "$WATCHDOG" ]; then warn "pm2_watchdog.sh not found in scripts/standalone"
elif crontab -l 2>/dev/null | grep -qF "$WATCHDOG"; then ok "watchdog already in cron"
elif [ "$CHECK_ONLY" -eq 1 ] || [ "$NO_CRON" -eq 1 ]; then
  warn "watchdog not in cron; to add it: crontab -e and these 2 lines:"
  printf '%s\n' "$CRON_LINES" | while read -r l; do todo "$l"; done
else
  [ -x "$WATCHDOG" ] || chmod 775 "$WATCHDOG"
  info "the watchdog restarts pm2 / the portal apps when they stop (every 5 minutes and after a reboot)"
  info "fill in ${ENVIRONMENT}_APP_DIR / NODE_BIN_DIR / PM2_HOME_DIR at the top of pm2_watchdog.sh if they differ from the defaults"
  if ask "Add the watchdog to this user's crontab?"; then
    if { crontab -l 2>/dev/null; printf '%s\n' "$CRON_LINES"; } | crontab -; then ok "watchdog added to cron"; else fail "could not update cron"; fi
  else
    warn "watchdog not added; to add it later: crontab -e and these 2 lines:"
    printf '%s\n' "$CRON_LINES" | while read -r l; do todo "$l"; done
  fi
fi

# ---------- summary ----------
out ""
out "== Summary =="
if [ "$FAILS" -gt 0 ]; then out "  $FAILS problem(s) (FAIL) above: fix them and run again."
else out "  $ENVIRONMENT setup $([ "$CHECK_ONLY" -eq 1 ] && echo 'checked' || echo 'done'): users open https://$(hostname):${WEB_PORT:-60443}/CBGM and /SRE"; fi
if [ ${#WARNS[@]} -gt 0 ]; then
  out "  To look at (${#WARNS[@]} warning(s)):"
  for w in "${WARNS[@]}"; do out "   - $w"; done
fi
out "  Still by hand: open TCP ${WEB_PORT:-60443} to users; add people to the user table (or CBGM Admin > User Management)"
[ -n "$LOG_FILE" ] && out "  Log: $LOG_FILE"
[ "$FAILS" -gt 0 ] && exit 1
exit 0
