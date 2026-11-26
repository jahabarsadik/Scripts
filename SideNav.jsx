import { useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import useNavMenus from './useNavMenus';
import usePendingApprovals from './usePendingApprovals';
import { useAuth } from '../context/AuthContext';

/**
 * Red menu on the left (menus from navConfig.js). A menu with sub-pages opens like an accordion: one open at a time;
 * the one holding the current page starts open. open / onClose: shown or hidden (the ☰ button in the header).
 * onToggle: pin the menu open (Expand View / Keep Expanded) or collapse it (Collapse View).
 * Computer, collapsed (the default after login): a narrow bar (rail) with each main menu's icon and name. Pointing at
 * the bar slides the full menu out OVER the page (the page does not move); moving the mouse off it, or choosing a page,
 * slides it back. Keep Expanded at its bottom pins it open. Phones: the menu is hidden instead (☰ in the header).
 */
// Name under the icon in the narrow bar: long words shortened
const railLabel = (label) => String(label).replace(/Management/g, 'Mgmt');
export default function SideNav({ open, onClose, onToggle }) {
  const { menus, isActive, itemVisible, path } = useNavMenus();
  // My Approval: the number of requests waiting for the user (CBGM, or SRE > CBGM Alerts for a CBGM user)
  const { module, profiles } = useAuth();
  const pending = usePendingApprovals(module.key === 'cbgm' || profiles.cbgm?.status === 'ok');
  const count = (key, cls = 'ms-auto') => (key === 'myApprovals' && pending > 0
    ? <span className={`badge rounded-pill text-bg-danger nav-count ${cls}`} title={`${pending} waiting for your approval`}>{pending}</span> : null);
  const holds = (m) => (m.columns || []).some((col) => col.items.some((i) => i.key === 'myApprovals' && itemVisible(i)));
  // One sub-menu open at a time (accordion): opening a menu closes the one that was open
  const currentKey = () => (menus.find((m) => m.columns && isActive(m)) || {}).key || null;
  const [expanded, setExpanded] = useState(currentKey);

  // Moving to another page opens that page's menu and closes the others; a page outside any group (Overview, e.g. via
  // the DBS logo) closes them all
  useEffect(() => {
    setExpanded(currentKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const toggle = (key) => setExpanded((open) => (open === key ? null : key));

  // Collapsed on a computer: pointing at the bar shows the full menu over the page ("peek") until the mouse leaves it
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(null);
  const startPeek = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(true), 120); };
  const endPeek = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(false), 250); };
  const keepPeek = () => clearTimeout(peekTimer.current);
  useEffect(() => { clearTimeout(peekTimer.current); setPeek(false); }, [path, open]);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const shown = open || peek; // the full menu is on screen (pinned, or peeking)

  // Phones: close the menu after choosing a page
  const picked = () => {
    setPeek(false);
    if (window.matchMedia('(max-width: 991.98px)').matches) onClose();
  };
  const linkActive = (to) => path === to.toLowerCase().split('?')[0];

  // Slid out by a click (not by pointing): a click anywhere outside the menu slides it back
  useEffect(() => {
    if (!peek) return undefined;
    const close = (e) => { if (!e.target.closest('.side-nav, .side-rail')) setPeek(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [peek]);
  // Scroll buttons: when the menu is taller than the window, ▲ / ▼ show where there is more menu to see
  const navRef = useRef(null);
  const railRef = useRef(null);
  const [more, setMore] = useState({ up: false, down: false });
  const scroller = () => (shown ? navRef.current : railRef.current);
  const checkMore = () => {
    const el = scroller();
    if (!el) return setMore({ up: false, down: false });
    setMore({ up: el.scrollTop > 2, down: el.scrollTop + el.clientHeight < el.scrollHeight - 2 });
  };
  useEffect(() => {
    checkMore();
    const el = scroller();
    if (!el) return undefined;
    el.addEventListener('scroll', checkMore);
    window.addEventListener('resize', checkMore);
    return () => { el.removeEventListener('scroll', checkMore); window.removeEventListener('resize', checkMore); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, expanded, menus.length]);
  const scrollMenu = (dir) => {
    const el = scroller();
    if (el) el.scrollBy({ top: dir * Math.round(el.clientHeight * 0.6), behavior: 'smooth' });
  };

  const groupsOf = (m) => m.columns.map((col) => ({ ...col, items: col.items.filter(itemVisible) })).filter((col) => col.items.length);

  return (
    <>
      {/* Computer, collapsed: narrow bar with the main menus (icon + name) */}
      {!open && (
        <aside ref={railRef} className="side-rail d-none d-lg-flex" aria-label="Main menu (collapsed)" onMouseEnter={startPeek} onMouseLeave={endPeek}>
          <ul className="list-unstyled mb-0 side-rail-menu">
            {menus.map((m) => {
              const icon = m.icon || 'bi-grid';
              const active = isActive(m);
              if (!m.columns) {
                return (
                  <li key={m.key}>
                    <NavLink to={m.to} end className={`side-rail-link ${active ? 'active' : ''}`} title={m.label}>
                      <i className={`bi ${icon}`} aria-hidden="true" /><span>{railLabel(m.label)}</span>{count(m.key, 'side-rail-count')}
                    </NavLink>
                  </li>
                );
              }
              return (
                <li key={m.key}>
                  {/* click (or keyboard): open the full menu over the page with this menu opened */}
                  <button type="button" className={`side-rail-link ${active ? 'active' : ''}`}
                    aria-haspopup="true" title={m.label}
                    onClick={() => { setExpanded(m.key); clearTimeout(peekTimer.current); setPeek(true); }}>
                    <i className={`bi ${icon}`} aria-hidden="true" /><span>{railLabel(m.label)}</span>{holds(m) && count('myApprovals', 'side-rail-count')}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="side-rail-bottom">
            <button type="button" className="side-rail-expand" onClick={onToggle} title="Expand View">
              <i className="bi bi-chevron-double-right" aria-hidden="true" /><span>Expand</span>
            </button>
          </div>
        </aside>
      )}
      <aside ref={navRef} className={`side-nav ${shown ? 'open' : ''} ${peek && !open ? 'peek' : ''}`} aria-label="Main menu" aria-hidden={!shown}
        onMouseEnter={peek ? keepPeek : undefined} onMouseLeave={peek && !open ? endPeek : undefined}>
        <ul className="list-unstyled side-menu mb-0">
          {menus.map((m) => {
            const icon = m.icon || 'bi-grid'; // icon: navConfig.js (SRE and CBGM menus)
            if (!m.columns) {
              return (
                <li key={m.key}>
                  <NavLink to={m.to} end className={`side-link side-top ${isActive(m) ? 'active' : ''}`} onClick={picked}>
                    <i className={`bi ${icon}`} aria-hidden="true" /><span>{m.label}</span>{count(m.key)}
                  </NavLink>
                </li>
              );
            }
            const isOpen = expanded === m.key;
            const groups = groupsOf(m);
            return (
              <li key={m.key}>
                <button type="button" className={`side-link side-top side-toggle ${isActive(m) ? 'active-parent' : ''}`} aria-expanded={isOpen} onClick={() => toggle(m.key)}>
                  <i className={`bi ${icon}`} aria-hidden="true" /><span>{m.label}</span>
                  {!isOpen && holds(m) && count('myApprovals')}
                  <i className={`bi bi-chevron-${isOpen ? 'up' : 'down'} ${!isOpen && holds(m) && pending > 0 ? 'ms-2' : 'ms-auto'} side-chevron`} aria-hidden="true" />
                </button>
                {isOpen && (
                  <div className="side-sub">
                    {groups.map((col) => (
                      <div key={col.title} className="side-group">
                        {/* the heading is left out when it only repeats the menu name */}
                        {col.title !== m.label && <div className="side-heading">{col.title}</div>}
                        <ul className="list-unstyled mb-0">
                          {col.items.map((item) => (
                            <li key={item.label}>
                              <Link to={item.to} className={`side-link side-item ${item.sub ? 'side-item-sub' : ''} ${linkActive(item.to) ? 'active' : ''}`} onClick={picked}>
                                <i className={`bi ${item.icon || 'bi-chevron-right'}`} aria-hidden="true" /><span>{item.label}</span>{count(item.key)}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {m.feature && m.requiresModule && (
                      <Link to={m.feature.to} className="side-link side-item side-feature" onClick={picked}>
                        <i className="bi bi-box-arrow-up-right" aria-hidden="true" /><span>{m.feature.cta || 'Open'}</span>
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {/* Bottom of the menu, always visible: pinned -> Collapse View; slid out over the page -> Keep Expanded (pin) */}
        <div className="side-bottom">
          {open ? (
            <button type="button" className="side-hide-btn" onClick={onToggle} title="Collapse View">
              <i className="bi bi-chevron-double-left" aria-hidden="true" /><span>Collapse View</span>
            </button>
          ) : (
            <button type="button" className="side-hide-btn" onClick={() => { setPeek(false); onToggle(); }} title="Keep Expanded">
              <i className="bi bi-pin-angle" aria-hidden="true" /><span>Keep Expanded</span>
            </button>
          )}
        </div>
      </aside>
      {/* Scroll buttons over the menu (full menu, or the narrow bar on computers) */}
      {more.up && (
        <button type="button" className={`side-scroll-btn up ${shown ? '' : 'rail d-none d-lg-flex'}`} onClick={() => scrollMenu(-1)} aria-label="Scroll menu up" title="Scroll up">
          <i className="bi bi-chevron-up" aria-hidden="true" />
        </button>
      )}
      {more.down && (
        <button type="button" className={`side-scroll-btn down ${shown ? '' : 'rail d-none d-lg-flex'}`} onClick={() => scrollMenu(1)} aria-label="Scroll menu down" title="Scroll down">
          <i className="bi bi-chevron-down" aria-hidden="true" />
        </button>
      )}
      {/* Phones: tab at the left edge while the menu is hidden (computers have the narrow bar's Expand instead) */}
      {!open && (
        <button type="button" className="side-edge-toggle d-lg-none" onClick={onToggle} aria-label="Expand View" title="Expand View" aria-expanded={false}>
          <i className="bi bi-chevron-right" aria-hidden="true" />
        </button>
      )}
      {/* Phones: tap outside the menu to close it */}
      {open && <div className="side-nav-backdrop d-lg-none" onClick={onClose} aria-hidden="true" />}
    </>
  );
}
