import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import boltMark from "../../assets/logos/boltv2straight.svg";
import { adminAreas } from "../config/navigation";
import { AdminIcon } from "./AdminIcon";
import { AdminAccountWidget } from "../auth/AdminAccountWidget";

export type AdminShellOutletContext = {
  startLoading: (reason?: string) => () => void;
};

const topLevelAdminAreas = adminAreas.filter((area) => !area.parentPath);
const commerceAdminAreas = adminAreas.filter((area) => area.parentPath === "/commerce");

export function AdminShell() {
  const location = useLocation();
  const commerceActive = location.pathname === "/commerce" || location.pathname.startsWith("/commerce/");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarPreference);
  const [commerceOpen, setCommerceOpen] = useState(commerceActive);
  const [loadingReason, setLoadingReason] = useState("");
  const menuButton = useRef<HTMLButtonElement>(null);
  const loadingTokens = useRef(new Map<symbol, string>());

  const startLoading = useCallback((reason = "Loading Admin view") => {
    const token = Symbol("admin-shell-loading");
    loadingTokens.current.set(token, reason.trim() || "Loading Admin view");
    setLoadingReason(loadingTokens.current.values().next().value || "Loading Admin view");

    return () => {
      if (!loadingTokens.current.delete(token)) return;
      setLoadingReason(loadingTokens.current.values().next().value || "");
    };
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    if (commerceActive) setCommerceOpen(true);
    window.scrollTo(0, 0);
  }, [commerceActive, location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  useEffect(() => {
    try { window.localStorage.setItem("thirdrailify.admin.sidebar", collapsed ? "collapsed" : "expanded"); } catch { /* Preference persistence is optional. */ }
  }, [collapsed]);

  useEffect(() => {
    document.documentElement.classList.toggle("admin-mobile-nav-open", mobileOpen);
    return () => document.documentElement.classList.remove("admin-mobile-nav-open");
  }, [mobileOpen]);

  const currentArea = adminAreas.find((area) => area.path === location.pathname)
    ?? (location.pathname.startsWith("/goats/") ? adminAreas.find((area) => area.path === "/goats") : undefined);

  return (
    <div className={`admin-layout${collapsed ? " admin-layout--collapsed" : ""}`}>
      <a className="skip-link" href="#admin-main">Skip to content</a>
      <aside id="admin-sidebar" className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`} aria-label="Admin navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><img src={boltMark} alt="" /></span>
          <div className="brand-lockup__copy"><strong>THIRD RAILIFY</strong><span>CONTROL ROOM</span></div>
        </div>

        <div className="environment-note">
          <span className="status-dot" aria-hidden="true" />
          <div><strong>Authenticated staging</strong><span>D1 account authority</span></div>
        </div>

        <nav className="primary-nav">
          <p className="nav-label">Workspace</p>
          {topLevelAdminAreas.map((area) => area.path !== "/commerce" ? (
            <NavLink key={area.path} to={area.path} end={area.path === "/"} aria-label={area.label} title={collapsed ? area.label : undefined} className={({ isActive }) => isActive ? "nav-link nav-link--active" : "nav-link"}>
              <AdminIcon name={area.icon} />
              <span>{area.label}</span>
            </NavLink>
          ) : (
            <div key={area.path} className={`nav-group${commerceOpen ? " nav-group--open" : ""}${commerceActive ? " nav-group--active" : ""}`}>
              <div className="nav-group__row">
                <NavLink to={area.path} end aria-label={area.label} title={collapsed ? area.label : undefined} className={({ isActive }) => isActive ? "nav-link nav-link--active" : "nav-link"}>
                  <AdminIcon name={area.icon} />
                  <span>{area.label}</span>
                </NavLink>
                <button className="nav-group__toggle" type="button" aria-expanded={commerceOpen} aria-controls="commerce-navigation" aria-label={commerceOpen ? "Collapse commerce navigation" : "Expand commerce navigation"} onClick={() => setCommerceOpen((value) => !value)}>
                  <AdminIcon name="chevron" size={15} />
                </button>
              </div>
              <div id="commerce-navigation" className="nav-group__children" hidden={!commerceOpen}>
                {commerceAdminAreas.map((child) => (
                  <NavLink key={child.path} to={child.path} aria-label={child.label} className={({ isActive }) => isActive ? "nav-link nav-link--nested nav-link--active" : "nav-link nav-link--nested"}>
                    <AdminIcon name={child.icon} size={17} />
                    <span>{child.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <AdminIcon name="shield" />
          <p><strong>Least privilege</strong><span>Account writes require Master Admin.</span></p>
        </div>
      </aside>

      {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <div className="admin-workspace">
        <header className="topbar">
          <button ref={menuButton} className="icon-button menu-button" type="button" aria-expanded={mobileOpen} aria-controls="admin-sidebar" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} onClick={() => setMobileOpen((value) => !value)}>
            <AdminIcon name={mobileOpen ? "close" : "menu"} />
          </button>
          <button className="topbar-collapse" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={collapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>
            <AdminIcon name="collapse" size={16} />
          </button>
          <div className="topbar-title"><span>Admin /</span><strong>{currentArea?.shortLabel ?? "Not found"}</strong></div>
          <AdminAccountWidget />
          <div className={`admin-shell-loading${loadingReason ? " is-active" : ""}`} role="status" aria-live="polite" aria-hidden={!loadingReason} aria-label={loadingReason || "Idle"}>
            <span className="admin-shell-loading__track" aria-hidden="true" />
            <span className="admin-shell-loading__bar" aria-hidden="true" />
          </div>
        </header>
        <main id="admin-main" className="admin-main" tabIndex={-1} aria-busy={Boolean(loadingReason)}>
          <Outlet context={{ startLoading }} />
        </main>
      </div>
    </div>
  );
}

function readSidebarPreference() {
  try { return window.localStorage.getItem("thirdrailify.admin.sidebar") === "collapsed"; }
  catch { return false; }
}
