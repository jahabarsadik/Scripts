/**
 * SRE Portal configuration: app, login, database and LDAP settings.
 * One set of settings for every server. Whatever differs between LOCAL, UAT and PROD (hosts, ports, URLs, certificate
 * files) and every secret / password comes from one .env file in this folder (env.js reads it), chosen from this
 * server's hostname:
 *   x01scbgm*  -> UAT   -> backend/src/config/.env.uat
 *   x01gcbgm*  -> PROD  -> backend/src/config/.env.prod
 *   anything else (e.g. a developer Mac) -> LOCAL -> backend/src/config/.env
 * The environment is the same rule (ENVIRONMENT in the file can override it). config.js is in git (it holds no
 * secret and no server value); the .env files are NOT (they hold the passwords).
 * It decides e.g. whether emails are really sent (mail.deliverIn).
 *
 * Login checks the LDAP servers in order (REG1, then REG3). If both reject the login or cannot be reached, the user
 * sees "User name and Password are incorrect".
 */
const os = require('os');
const path = require('path');


// Settings that differ per server and secrets: from .env / .env.uat / .env.prod in this folder (env.js)
const { env, envFile, environmentForHost } = require('./env'); // the file: .env.uat (UAT), .env.prod (PROD), .env (LOCAL)

const hostname = os.hostname();
const environment = String(env('ENVIRONMENT') || environmentForHost(hostname)).trim().toUpperCase();
// .env values are text: these turn them into true / false, numbers, lists and objects (default when not set)
const bool = (name, def) => { const v = env(name); return v === '' ? def : /^(1|true|yes|on)$/i.test(v.trim()); };
const int = (name, def) => { const v = env(name); return v === '' ? def : Number(v); };
const list = (name) => env(name).split(',').map((x) => x.trim()).filter(Boolean);
function json(name, def) {
  const v = env(name);
  if (!v) return def;
  try { return JSON.parse(v); } catch { throw new Error(`config.js: ${name} in .env is not valid JSON`); }
}
// One LDAP server (REG1 / REG3): LDAP_<NAME>_HOST, _PORT, _SECURE, ... in .env
const ldapServer = (name) => ({
  name,
  host: env(`LDAP_${name}_HOST`), // directory server host name or IP
  port: int(`LDAP_${name}_PORT`, 389), // 389 = ldap://, 636 = ldaps://
  secure: bool(`LDAP_${name}_SECURE`, false), // true = ldaps:// (TLS from the start)
  baseDN: env(`LDAP_${name}_BASE_DN`),
  // A) Direct bind: DN used to log the user in ({{username}} = 1bank ID)
  userDNTemplate: env(`LDAP_${name}_USER_DN_TEMPLATE`),
  // B) Search then bind (used when serviceDN is not empty): the service account finds the user, then the user's own
  // password is checked against the DN that was found
  serviceDN: env(`LDAP_${name}_SERVICE_DN`),
  servicePassword: env(`LDAP_${name}_SERVICE_PASSWORD`),
  searchBase: env(`LDAP_${name}_SEARCH_BASE`),
  searchFilter: env(`LDAP_${name}_SEARCH_FILTER`, '(uid={{username}})'), // Active Directory: (sAMAccountName={{username}})
  startTLS: bool(`LDAP_${name}_START_TLS`, false),
  rejectUnauthorized: bool(`LDAP_${name}_REJECT_UNAUTHORIZED`, false), // false = do not verify the server certificate
  caFile: env(`LDAP_${name}_CA_FILE`), // company CA certificate (PEM) if Node does not trust the LDAPS certificate
  timeoutMs: int(`LDAP_${name}_TIMEOUT_MS`, 10000),
});

// This server's settings (from .env)
const site = {
  // Modules on / off: true = login and all pages work; false = /CBGM or /SRE shows a "Coming soon" page and its login
  // and API are refused
  CBGM_Module: bool('CBGM_MODULE', true),
  SRE_Module: bool('SRE_MODULE', true),
  // Home page "/": SRE_REDIRECT true -> opens /SRE; CBGM_REDIRECT true -> opens /CBGM; both false -> the "Choose your
  // workspace" page (both true: /SRE)
  SRE_Redirect: bool('SRE_REDIRECT', false),
  CBGM_Redirect: bool('CBGM_REDIRECT', false),
  // Second login step: after LDAP, sign in through SSO (OAuth2, the sso settings below); false = LDAP only
  SSO_CHECK: bool('SSO_CHECK', false),
  // S3 bucket for attachments (also kept in the Attachment folder). Any empty value = S3 off.
  s3: {
    S3_ENDPOINT: env('S3_ENDPOINT'),
    S3_BUCKET: env('S3_BUCKET'),
    S3_REGION: env('S3_REGION', 'ap-southeast-1'),
    S3_ACCESS_KEY: env('S3_ACCESS_KEY'),
    S3_SECRET_KEY: env('S3_SECRET_KEY'),
    rejectUnauthorized: bool('S3_REJECT_UNAUTHORIZED', false),
  },
  // Other web addresses allowed to call the API from a browser (CORS), comma separated. LOCAL: the React dev server;
  // UAT / PROD: empty (pages and API come from the same address)
  clientOrigin: list('CLIENT_ORIGIN').length ? list('CLIENT_ORIGIN') : undefined,
  portalUrl: env('PORTAL_URL'), // links in emails; empty = worked out from this server (see portalUrlFor)
  infraHealthStatusUrl: env('INFRA_HEALTH_STATUS_URL'), // Infra Ops > Infra Health Status link
  // frontend: React dev server (LOCAL), forwards /api to the API port; api: Express API; web: Express serving the built
  // React app (frontend/dist) and /api together (UAT / PROD: WEB_PORT=60443, HTTPS)
  ports: { frontend: int('FRONTEND_PORT', 60443), api: int('API_PORT', 61443), web: int('WEB_PORT', 62443) },
  auth: { jwtSecret: env('JWT_SECRET') }, // REQUIRED (openssl rand -hex 64). PROD: the SAME value on both servers behind GTM
  // Second login step after LDAP (SSO_CHECK): OAuth2 / OpenID Connect. BASE_OAUTH_URL + /authorize, /access_token,
  // /idtokeninfo, /revoke. REDIRECT_URI: this portal's /sso/callback page as registered with the SSO server.
  sso: {
    BASE_OAUTH_URL: env('SSO_BASE_OAUTH_URL'),
    CLIENT_ID: env('SSO_CLIENT_ID'),
    CLIENT_SECRET: env('SSO_CLIENT_SECRET'),
    REDIRECT_URI: env('SSO_REDIRECT_URI'),
    SCOPE: env('SSO_SCOPE', 'openid'),
    USER_CLAIM: env('SSO_USER_CLAIM', 'sub'), // ID token claim holding the 1bank ID
    CLIENT_AUTH: env('SSO_CLIENT_AUTH', 'basic'), // 'basic' or 'post'
    SEND_LOGIN_HINT: bool('SSO_SEND_LOGIN_HINT', true), // CyberSecure push: the SSO login does not ask for the 1bank ID again
    AUTHORIZE_PARAMS: json('SSO_AUTHORIZE_PARAMS', {}), // e.g. {"service":"PushOnly"}
    rejectUnauthorized: bool('SSO_REJECT_UNAUTHORIZED', false),
  },
  // HTTPS (UAT / PROD): certificate files in the project's ssl/ folder. HTTPS_CERT_FILE empty = plain HTTP (LOCAL)
  https: env('HTTPS_CERT_FILE')
    ? { certFile: env('HTTPS_CERT_FILE'), keyFile: env('HTTPS_KEY_FILE'), caFile: env('HTTPS_CA_FILE'), passphrase: env('SSL_KEY_PASSPHRASE') }
    : undefined,
  // Admin > Create User looks up the 1bank ID in Active Directory (REG1 / REG3); false = type the name and email in
  ldapUserCheck: bool('LDAP_USER_CHECK', true),
  db: { host: env('DB_HOST'), port: int('DB_PORT', 3306), user: env('DB_USER'), password: env('DB_PASSWORD'), database: env('DB_NAME') },
  ldap: [ldapServer('REG1'), ldapServer('REG3')], // tried in this order: REG1 first, then REG3
  // CBGM > Tier-2 Journey (1bank IDs):
  //   MTJ_Tier2_Maker   - may add and edit Tier-2 Journeys (Add Tier-2 Journey page, Edit on Tier-2 Journey Management); each
  //                add / edit is a request for a Checker
  //   MTJ_Tier2_Checker - the approvers: the Maker chooses one, who approves / rejects on My Approval (Tier-2 Journey
  //                Approval); approved rows go into c2e_mtj_journey_app. Nobody approves their own request.
  MTJ_Tier2_Maker: list('MTJ_TIER2_MAKER'), // 1bank IDs separated by commas
  MTJ_Tier2_Checker: list('MTJ_TIER2_CHECKER'),
  // CBGM > Onboard New Alerts: the CBGM Team reviewers (1bank IDs) who approve / reject a request on My Approval
  // after the SRE Lead approved it, and get the "waiting for CBGM Team approval" email. Each needs an active
  // cbgm_portal_users row (instead of the cbgm_alert_reviewer table)
  CBGMAlertReviewer: list('CBGM_ALERT_REVIEWER'), // 1bank IDs separated by commas
  // Page colours in both modules (SRE and CBGM). Accepted values per item:
  //   sideMenu, header           : 'red' (default) | 'black' (charcoal)
  //   tableHeader, section, tab  : 'red' (default) | 'black' (charcoal) | any colour code '#rgb' / '#rrggbb' such as '#1f3b6f'
  //                                (the text on them is white, so choose a dark colour)
  //       Colour codes that work well with white text:
  //         '#1f3b6f' navy blue     '#0d47a1' dark blue     '#00695c' teal          '#1b5e20' dark green
  //         '#4a148c' purple        '#6a1b9a' violet        '#880e4f' maroon        '#b71c1c' dark red
  //         '#bf360c' burnt orange  '#3e2723' dark brown    '#37474f' slate grey    '#212121' near black
  //   submitButton               : 'blue' (default) | 'red' | 'black' (charcoal)
  //   Anything else counts as the default.
  chooseColor: {
    sideMenu: env('UI_SIDE_MENU_COLOR', 'red'),           // left menu, expanded and collapsed                       : 'red' | 'black'
    header: env('UI_HEADER_COLOR', 'red'),                // page banner (title, breadcrumb) + Search / user-menu buttons : 'red' | 'black'
    tableHeader: env('UI_TABLE_HEADER_COLOR', 'red'),     // table header rows (every table)                           : 'red' | 'black' | '#rrggbb'
    section: env('UI_SECTION_COLOR', 'red'),              // section headers on every page and side panels             : 'red' | 'black' | '#rrggbb'
    tab: env('UI_TAB_COLOR', 'red'),                      // the selected tab (e.g. My Request / My Approval)          : 'red' | 'black' | '#rrggbb'
    submitButton: env('UI_SUBMIT_BUTTON_COLOR', 'blue'),  // Submit buttons (Submit, Run Report, Create Ticket ...)    : 'blue' | 'red' | 'black'
  },
};

// Settings that are the same on every server (nothing here is in .env)
const shared = {
  webRoot: path.join(__dirname, '../../../frontend/dist'), // built React app served on ports.web
  jwtExpiresIn: '30m', // log out after this long WITHOUT ACTIVITY (60 s "extend?" popup first); e.g. '30m', '1h'


  // Log files (a new set each day): backend-access-, backend-error-, frontend-access-, frontend-error-YYYYMMDD.log
  // Logs folder (incident-portal/logs). retentionDays: backend-access*, backend-error*, frontend-access*,
  // frontend-error*, pm2-backend* and pm2-frontend* files not changed for longer than this are deleted (checked at start-up
  // and once a day); other files there (saved emails, setup / watchdog logs) are kept. 0 = keep all.
  logs: { dir: path.join(__dirname, '../../../logs'), retentionDays: 14 },

  // Incident ticket attachments: on disk in <dir>/SRE/<ticket_number>/ and in the S3 bucket (when s3 is set)
  // as objects <incidentS3Prefix>/<ticket_number>/<file>, e.g. SRE_Portal/Incident/CCTN202610210001/screenshot.png
  // ADR Review action item attachments (one file per item): on disk in <dir>/SRE/ADR/ADR_<project id>_<item id>/ and in
  // the S3 bucket as <adrS3Prefix>/ADR_<project id>_<item id>/<file>
  // SRE Metrics > Weekly P99 Dashboard: by default only APIs whose P99 went up by at least rtIncreaseSec seconds
  // (vs the week before) and that had at least minVolume requests in the week; the page toggles include the others
  p99Weekly: { rtIncreaseSec: 0.5, minVolume: 5000 },
  // Input files the portal reads (not uploaded through the pages), e.g. JSON for Infra Ops > Capacity Review:
  // <dir>/<capacity>/*.json. The folders are in git (.gitkeep); the files are not.
  inputs: {
    dir: path.join(__dirname, '../../../Input'),
    capacity: 'InfraOps/Capacity',
    // Infra Ops > Capacity Review Overview: the JSON files in <dir>/<capacity>/ (names matched without case)
    capacityFiles: {
      overview: 'Dashboard_Data_Overview.json', // Platform > App Code > CPU / MEM / FS / Uptime > { YELLOW, RED }: count
      uptime: 'Dashboard_Data_Uptime.json', // Platform > App Code > Hostname: uptime
      cpuMem: 'Dashboard_Data_CPU_MEM_All.json', // CPU | MEM > Platform > App Code > Hostname > Year > Month: value
      fs: 'Dashboard_Data_FS_All.json', // Platform > App Code > Hostname > Filesystem > Year > Month: value
    },
    // Colour of the CPU / Memory / File System % in the App Code pop-up: > red: red, >= saffron: saffron, >= yellow: yellow,
    // below yellow: green
    capacityLevels: { red: 80, saffron: 70, yellow: 60 },
    capacityUptimeDays: 180, // Uptime pop-up: hosts up longer than this many days are red (legend "> 180 days")
  },
  // Reports made by the batch jobs, downloaded with the pages' Download Report button: the newest .xlsx file in
  // <dir>/<folder> whose name starts with <prefix> (matched without case; '' = any .xlsx file in the folder).
  // Reports sharing a folder need different prefixes.
  reports: {
    dir: path.join(__dirname, '../../../Reports'),
    list: {
      capacityOverview: { folder: 'InfraOps', prefix: 'Capacity_Review' }, // Infra Ops > Capacity Review Overview
      changeOverview: { folder: 'ChangeMetrics', prefix: 'Change_Metrics_Overview' }, // SRE Metrics > Change Metrics > Overview
      failedChange: { folder: 'ChangeMetrics', prefix: 'Failed_Change' }, // SRE Metrics > Change Metrics > Failed Change
      sl4Metrics: { folder: 'IncidentMetrics', prefix: 'SL4_Metrics' }, // SRE Metrics > Incident Metrics > SL4
    },
  },
  // CBGM > Admin > Alert Config: values filled in when Add is clicked (the admin can change them before saving).
  // null = empty (NULL in the table)
  alertConfigDefaults: {
    host: { HOST_AGENT_DIR: '/cbgm', HOST_INTERFACE_ID: 'p01gcbgm', isActive: 1, HOSTGROUPID: null, SUB_GRP: null, HOST_CTRY_MAP_ID: 0, ISM_GRP: '' },
    hostgroup: { isActive: 1, IS_GRPCODE_SHARED: 0, DEPT_CODE: 'CBG', CATEGORY: '2' },
    section: { valid_id: 1 },
  },
  // CBGM > Tier-2 Journey > Add: every Health Check ID must start with this (e.g. HCA_P2P-SG_0001)
  MTJ_tier2_healthIdPrefix: 'HCA_',
  // CBGM > Onboard New Alerts: new services shown at a time. When an index has more, the first ones are shown; once
  // they are submitted for approval the next ones appear, until none are left
  onboardServicesPerBatch: 50,
  // Admin > Incident Management > Platform Owner: c2e_flag of new pm_platform_names rows
  incidentMasters: { platformC2eFlag: 1 },
  attachments: { dir: path.join(__dirname, '../../../Attachment'), incidentS3Prefix: 'SRE_Portal/Incident', adrS3Prefix: 'SRE_Portal/ADR' },

  // Email notifications (sendmail). Only the environments in deliverIn really send email;
  // the others (LOCAL, UAT) save each message as an .eml file in the logs folder instead.
  mail: {
    deliverIn: ['PROD'],
    sendmailPath: '/usr/sbin/sendmail', // sendmail service on the PROD server (called as: sendmail -t -i)
    cbgmFrom: 'CBGM APM Support <cbgtapmsupport@1bank.dbs.com>', // CBGM emails
    cbgmDelegates: ['aakash@dbs.com', 'jyothi@dbs.com'], // Cc on every CBGM email
    // SRE emails: Incident and Action Item emails, and all ADR emails
    sreFrom: 'T&O-C2E-IPC-Report <cstdashboard@dbs.com>',
    changeFrom: 'C2E Change Management <cstchangemgmt@dbs.com>',
    domain: 'dbs.com', // 1bank ID -> <1bank ID>@<domain> (requesters, SRE Leads)
    support: 'cbgtapmsupport@1bank.dbs.com', // CBGM support mailbox, copied (Cc) on every notification
    // SRE: a new action item is mailed to its assignee, Cc the assignee's manager and these mailboxes
    sreActionItemCc: ['applicationincidentmanagement@dbs.com', 'appccd@dbs.com'],
    // SRE > ADR emails (New Schedule submitted, ADR Review submitted): always Cc these Change delegates
    ChangeDelegates: ['nelson@dbs.com', 'abcan@dbs.com'],
  },

  // User tables checked after LDAP (REG1, then REG3): the person must be an active row here to get in.
  userTables: {
    // CBGM: every table, column and value used to authorise CBGM users
    cbgm: {
      table: 'user',
      columns: {
        id: 'USERID',
        loginId: 'LOGINID', // 1bank ID used to log in (the PASSWORD column is never checked)
        fullName: 'USERNAME', // used when Active Directory has no first / last name
        email: 'EMAIL',
        roleName: 'ROLE_NAME',
        active: 'ISACTIVE',
        createdAt: 'CREATED_DT',
        updatedAt: 'LAST_UPDATED_DT',
        application: 'APPLICATION', // App Codes the user works on, comma-separated
      },
      activeValue: 1, // user.ISACTIVE = 1 -> allowed to log in (inactive users are saved with 0)
      // First / last name from Active Directory, saved at login
      portalUsersTable: 'cbgm_portal_users',
      portalUsersColumns: { id: 'id', loginId: '1bank_id', firstName: 'first_name', lastName: 'last_name', active: 'valid_id' },
      portalUsersActiveValue: 1,
      // Admins: a row in adminTable (user_id = cbgm_portal_users.id), both rows active
      adminTable: 'cbgm_admin_users',
      adminColumns: { userId: 'user_id', active: 'valid_id' },
      adminActiveValue: 1,
      adminRoleName: 'ADMIN', // Create / Edit User: this role (and Active) adds the person to adminTable; another role or Inactive sets valid_id 0
      accessDeniedMessage: 'Permission denied to access this portal. Contact CBGM Support Team <cbgtapmsupport@1bank.dbs.com> to access this.',
    },
    // SRE: every table, column and value used to authorise SRE users
    sre: {
      table: 'pm_users',
      columns: {
        id: 'id',
        loginId: '1bank_id', // 1bank ID used to log in
        firstName: 'first_name',
        lastName: 'last_name',
        email: 'email_address',
        role: 'role', // used when the user has no row in roleLinkTable
        active: 'valid_id',
        createdAt: 'create_time',
      },
      activeValue: 1, // pm_users.valid_id = 1 -> allowed to log in
      // Roles: roleLinkTable (user -> role) joined to roleTable; only active roles count
      roleLinkTable: 'pm_user_role',
      roleLinkColumns: { userId: 'user_id', roleId: 'role_id' },
      roleTable: 'pm_roles',
      roleColumns: { id: 'id', name: 'role_name', active: 'valid_id' },
      roleActiveValue: 1,
      // Any of these roles (case-insensitive) gives access to the SRE Admin pages
      adminRoleNames: ['Admin'], // pm_roles.role_name 'Admin' (not case-sensitive)
      // Admin > Create User / User Management (SRE): new pm_users rows get role = newUserRole; the pm_user_role row
      // gets these permissions for its pm_roles.role_name (not case-sensitive). Any other active role: defaultPermissions.
      newUserRole: 'rw',
      rolePermissions: {
        Admin: { txt_create: 'Yes', txt_update: 'Yes', txt_view: 'Yes', act_item_create: 'Yes', act_item_update: 'Yes' },
        'Command Center': { txt_create: 'Yes', txt_update: 'Yes', txt_view: 'Yes', act_item_create: 'Yes', act_item_update: 'Yes' },
        'Incident Manager': { txt_create: 'Yes', txt_update: 'Yes', txt_view: 'Yes', act_item_create: 'Yes', act_item_update: 'Yes' },
        'Production Support': { txt_create: 'No', txt_update: 'No', txt_view: 'Yes', act_item_create: 'No', act_item_update: 'Yes' },
      },
      defaultPermissions: { txt_create: 'No', txt_update: 'No', txt_view: 'Yes', act_item_create: 'No', act_item_update: 'No' },
      // Roles that may only see / change tickets reported on or after a date (Reported Date to CC, YYYY-MM-DD): the
      // tickets, their action items and attachments, the Overview list, All / My Action Items and Incident Reports.
      // Creating tickets is not limited, but their Reported Date must be on or after the date. Admins see everything.
      // A user with several limited roles gets the latest date.
      roleTicketsFrom: { 'Command Center': '2025-08-01' },
      accessDeniedMessage: 'Permission denied to access this portal.',
    },
  },

  // Roles offered in Admin > User Management (Create / Edit User)
  // ADMIN: choosing it in Create / Edit User also makes the person a CBGM admin (userTables.cbgm.adminRoleName)
  userRoles: ['ADMIN', 'APP_ADMIN', 'APP_USER', 'VIEWER'],
};

// SSL certificate folder: <project>/ssl (certFile / keyFile / caFile names in the https blocks are read from here)
const SSL_DIR = path.join(__dirname, '../../../ssl');
const inSslDir = (file) => (file ? (path.isAbsolute(file) ? file : path.join(SSL_DIR, file)) : '');
const sslFiles = (h) => (h ? { ...h, certFile: inSslDir(h.certFile), keyFile: inSslDir(h.keyFile), caFile: inSslDir(h.caFile) } : h);

// Web address of the portal for links in emails. portalUrl set in the environment block wins (e.g. the GTM name on PROD);
// empty = worked out from this server: LOCAL http://localhost:<frontend port>, UAT/PROD https://<hostname>:<web port>
function portalUrlFor(env, environment, host) {
  const set = String(env.portalUrl || '').trim().replace(/\/+$/, '');
  if (set) return set;
  const { ports } = env;
  if (environment === 'LOCAL') return `${env.https ? 'https' : 'http'}://localhost:${ports.frontend}`;
  return `${env.https ? 'https' : 'http'}://${host}:${ports.web}`;
}
const selected = site;
// Login sessions are signed with auth.jwtSecret. PROD: the SAME value on both hosts behind GTM.
if (!selected.auth || !selected.auth.jwtSecret) throw new Error(`config.js: JWT_SECRET is empty for ${environment} (set it in ${envFile})`);

module.exports = {
  environment,
  hostname,
  ...shared,
  CBGM_Module: selected.CBGM_Module,
  SRE_Module: selected.SRE_Module,
  SRE_Redirect: selected.SRE_Redirect,
  CBGM_Redirect: selected.CBGM_Redirect,
  SSO_CHECK: selected.SSO_CHECK,
  MTJ_Tier2_Maker: selected.MTJ_Tier2_Maker,
  MTJ_Tier2_Checker: selected.MTJ_Tier2_Checker,
  CBGMAlertReviewer: selected.CBGMAlertReviewer,
  chooseColor: selected.chooseColor,
  sso: selected.sso || {}, // OAuth2 single sign-on settings (services/sso.js)
  ports: selected.ports,
  clientOrigin: selected.clientOrigin || false, // CORS: false = no other site may call the API
  portalUrl: portalUrlFor(selected, environment, hostname), // links in emails (e.g. CBGM approval -> My Approval)
  infraHealthStatusUrl: String(selected.infraHealthStatusUrl || '').trim(), // Infra Ops > Infra Health Status link
  auth: selected.auth,
  https: sslFiles(selected.https), // certificate files resolved to the ssl/ folder
  sslDir: SSL_DIR,
  db: {
    ...selected.db,
    connectionLimit: 10, // connection pool size
    timezone: 'local',
  },
  s3: selected.s3 || {}, // S3 bucket for SRE ticket attachments (services/sre/s3.js)
  ldap: {
    servers: selected.ldap,
    checkNewUsers: selected.ldapUserCheck !== false, // Create User: 1bank ID must exist in Active Directory
  },
};

// Developer machine add-ons: every .js file in backend/src/local (that folder is never in git, so on UAT / PROD there
// is nothing to load). Each may export install(), called once the backend has started.
setImmediate(() => {
  const dir = path.join(__dirname, '../local');
  let files = [];
  try { files = require('fs').readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { return; }
  for (const f of files) {
    try { const m = require(path.join(dir, f)); if (m && typeof m.install === 'function') m.install(); } catch (e) { console.error(`local/${f}: ${e.message}`); }
  }
});
