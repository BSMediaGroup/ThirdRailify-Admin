import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import boltMark from "../../assets/logos/boltv2straight.svg";
import { adminAreas } from "../config/navigation";
import { AdminIcon } from "./AdminIcon";
import { AdminAccountWidget } from "../auth/AdminAccountWidget";

export type AdminShellOutletContext = {
  startLoading: (reason?: string) => () => void;
};

export function AdminShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loadingReason, setLoadingReason] = useState("");
  const location = useLocation();
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
    window.scrollTo(0, 0);
  }, [location.pathname]);

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

  const currentArea = adminAreas.find((area) => area.path === location.pathname);

  return (
    <div className="admin-layout">
      <a className="skip-link" href="#admin-main">Skip to content</a>
      <aside id="admin-sidebar" className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`} aria-label="Admin navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><img src={boltMark} alt="" /></span>
          <div><strong>THIRD RAILIFY</strong><span>CONTROL ROOM</span></div>
        </div>

        <div className="environment-note">
          <span className="status-dot" aria-hidden="true" />
          <div><strong>Authenticated staging</strong><span>D1 account authority</span></div>
        </div>

        <nav className="primary-nav">
          <p className="nav-label">Workspace</p>
          {adminAreas.map((area) => (
            <NavLink key={area.path} to={area.path} end={area.path === "/"} className={({ isActive }) => isActive ? "nav-link nav-link--active" : "nav-link"}>
              <AdminIcon name={area.icon} />
              <span>{area.label}</span>
            </NavLink>
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
