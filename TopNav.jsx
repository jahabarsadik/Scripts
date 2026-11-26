import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { USER_MENU_LINKS } from './navConfig';
import usePendingApprovals from './usePendingApprovals';
import { MODULES } from '../modules';
import { useModuleStatus } from '../moduleStatus';
import dbsLogo from '../assets/dbs-logo.jpg';

/**
 * White header bar on every page: ☰ (show / hide the red left menu, SideNav.jsx), logo + module, SRE ticket search,
 * user menu. sideMenu: { open, toggle } from Layout.jsx.
 */
export default function TopNav({ sideMenu }) {
  const { user, module, logout } = useAuth();
  const pending = usePendingApprovals(module.key === 'cbgm'); // My Approval number (CBGM user menu)
  const navigate = useNavigate();
  const location = useLocation();
  const headerRef = useRef(null);
  const [openKey, setOpenKey] = useState(null);
  const [ticketSearch, setTicketSearch] = useState(''); // SRE: Incident Ticket Number# search in the header
  const moduleStatus = useModuleStatus();
  // CBGM -> "Switch to SRE": only when SRE is switched on in config.js (SRE_Module); hidden until that is known
  const switchTargets = module.switchTo.filter((k) => moduleStatus && moduleStatus[k] !== false).map((k) => MODULES[k]);
  const userMenuOpen = openKey === 'user';

  const closeAll = () => setOpenKey(null);
  useEffect(closeAll, [location.pathname, location.search]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && setOpenKey(null);
    const onClick = (e) => headerRef.current && !headerRef.current.contains(e.target) && setOpenKey(null);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  const path = location.pathname.toLowerCase().replace(/\/$/, '');
  // SRE: open the ticket on View/Modify Ticket (it loads the ticket from ?ticket=)
  const searchTicket = (e) => {
    e.preventDefault();
    const no = ticketSearch.trim();
    if (!no) return;
    navigate(`/SRE/incidents/view?ticket=${encodeURIComponent(no)}`);
    setTicketSearch('');
    closeAll();
  };

  const doLogout = () => {
    logout();
    navigate(`${module.path}/login`, { replace: true, state: { loggedOut: true } }); // single sign-on: wait for a click
  };

  return (
    <header className="site-header fixed-top" ref={headerRef}>
      {/* White bar: ☰, logo, module, search, user menu (the menus are on the left: SideNav.jsx) */}
      <nav className="navbar main-nav navbar-expand-lg" aria-label="Header">
        <div className="container-fluid px-3">
          <button type="button" className="btn side-nav-toggle me-2" aria-expanded={sideMenu.open} aria-label={sideMenu.open ? 'Collapse View' : 'Expand View'}
            title={sideMenu.open ? 'Collapse View' : 'Expand View'} onClick={sideMenu.toggle}>
            <i className={`bi ${sideMenu.open ? 'bi-text-indent-right' : 'bi-list'}`} />
          </button>
          <NavLink className="navbar-brand header-brand me-4" to={module.path} aria-label={`${module.name} home`}>
            <img src={dbsLogo} alt="DBS" className="header-logo" />
            <span className="header-module">{module.short}</span>
          </NavLink>
          <div className="d-flex align-items-center ms-auto" id="headerActions">
            {/* SRE: search icon; opens a wide search bar under the header (Ticket / Incident Ticket Number#) */}
            {module.key === 'sre' && (
              <button
                type="button"
                className="btn btn-header-action me-lg-2 my-2 my-lg-0"
                aria-expanded={openKey === 'search'}
                aria-controls="header-search-panel"
                aria-label="Search tickets"
                title="Search Ticket / Incident Ticket Number#"
                onClick={() => setOpenKey((k) => (k === 'search' ? null : 'search'))}
              >
                <i className="bi bi-search" />
              </button>
            )}
            {/* User icon: opens a menu with Switch to SRE (CBGM only) and Log out */}
            <div className="user-menu position-relative">
              <button
                type="button"
                className="btn btn-header-action"
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label={`Account menu for ${user.full_name}`}
                onClick={() => setOpenKey((k) => (k === 'user' ? null : 'user'))}
              >
                <i className="bi bi-person-circle user-icon" />
                <i className="bi bi-chevron-down small" />
              </button>
              {userMenuOpen && (
                <ul className="dropdown-menu dropdown-menu-end show user-dropdown shadow" role="menu">
                  <li className="px-3 py-2">
                    {/* Full name, 1bank ID, role (each on its own line) */}
                    <div className="fw-semibold">{user.full_name}</div>
                    <div className="small text-body-secondary">{user.username}</div>
                    <div className="small text-body-secondary">{user.role_name || '—'}</div>
                  </li>
                  <li><hr className="dropdown-divider" /></li>
                  {USER_MENU_LINKS[module.key].map((l) => (
                    <li key={l.to}>
                      <Link className={`dropdown-item ${path === l.to.toLowerCase() ? 'active' : ''}`} role="menuitem" to={l.to} onClick={closeAll}>
                        <i className={`bi ${l.icon} me-2`} />{l.label}
                        {l.key === 'myApprovals' && pending > 0 && <span className="badge rounded-pill text-bg-danger ms-2">{pending}</span>}
                      </Link>
                    </li>
                  ))}
                  {USER_MENU_LINKS[module.key].length > 0 && <li><hr className="dropdown-divider" /></li>}
                  {switchTargets.map((m) => (
                    <li key={m.key}>
                      <Link className="dropdown-item" role="menuitem" to={m.path} onClick={closeAll}>
                        <i className="bi bi-arrow-left-right me-2" />Switch to {m.short}
                      </Link>
                    </li>
                  ))}
                  <li>
                    <button type="button" className="dropdown-item text-danger" role="menuitem" onClick={doLogout}>
                      <i className="bi bi-box-arrow-right me-2" />Log out
                    </button>
                  </li>
                </ul>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Ticket search bar (opened with the search icon) */}
      {module.key === 'sre' && openKey === 'search' && (
        <div className="header-search-panel" id="header-search-panel" role="search">
          <div className="container-xl">
            <form className="header-search-form" onSubmit={searchTicket} autoComplete="off">
              <label className="form-label fw-semibold mb-2" htmlFor="header-ticket-search">
                Open a ticket
              </label>
              <div className="input-group input-group-lg">
                <span className="input-group-text bg-white"><i className="bi bi-search" /></span>
                <input
                  id="header-ticket-search"
                  type="search"
                  className="form-control"
                  placeholder="Enter Ticket Number (CCTN…) or Incident Ticket Number# (IN…)"
                  value={ticketSearch}
                  onChange={(e) => setTicketSearch(e.target.value)}
                  autoFocus
                />
                <button className="btn btn-danger px-4" type="submit" disabled={!ticketSearch.trim()}>
                  Search
                </button>
              </div>
              <div className="form-text">Press Enter to open the ticket on View/Modify Ticket · Esc to close</div>
            </form>
          </div>
        </div>
      )}
    </header>
  );
}
