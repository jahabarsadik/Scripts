// Which App Codes a CBGM user may work with (Overview, Onboard New Alerts, Alert Enable/Disable Request, Update
// Threshold, Update SOP ID, Application Blackout, and the same pages under SRE > CBGM Alerts):
//   - an administrator (req.user.is_admin): every App Code in config_service_threshold.app_code
//   - anyone else: their own App Codes, the comma-separated `user`.APPLICATION column (req.user.applications,
//     see services/userTable.js)
// appCodesFor(user) is the App Code dropdown of those pages; canUseApp / filterAppCodes check a chosen App Code.
const { query } = require('../db');

const norm = (s) => String(s || '').trim().toUpperCase();
const isAdmin = (user) => !!(user && user.is_admin);

/** Every App Code in config_service_threshold (sorted, no blanks) */
async function allAppCodes() {
  const rows = await query(`SELECT DISTINCT app_code FROM config_service_threshold WHERE app_code IS NOT NULL AND TRIM(app_code) <> '' ORDER BY app_code`);
  return [...new Set(rows.map((r) => String(r.app_code).trim()))];
}

/** The user's own App Codes from user.APPLICATION (sorted, no blanks or repeats) */
const ownAppCodes = (user) =>
  [...new Set((user && Array.isArray(user.applications) ? user.applications : []).map((a) => String(a || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

/** The App Code dropdown for this user: administrators every config_service_threshold App Code, others user.APPLICATION */
async function appCodesFor(user) {
  return isAdmin(user) ? allAppCodes() : ownAppCodes(user);
}

/** null = no restriction (administrators); otherwise the user's App Codes, upper case (may be empty) */
function allowedAppCodes(user) {
  if (isAdmin(user)) return null;
  return ownAppCodes(user).map(norm);
}

/** May this user use this App Code? */
function canUseApp(user, appCode) {
  const allowed = allowedAppCodes(user);
  return !allowed || allowed.includes(norm(appCode));
}

/** Keep only the App Codes the user may use */
function filterAppCodes(user, appCodes) {
  const allowed = allowedAppCodes(user);
  return allowed ? appCodes.filter((a) => allowed.includes(norm(a))) : appCodes;
}

const NO_ACCESS = 'You do not have access to this App Code. Contact CBGM Support Team to assign application to you';

module.exports = { appCodesFor, allAppCodes, ownAppCodes, allowedAppCodes, canUseApp, filterAppCodes, NO_ACCESS };
