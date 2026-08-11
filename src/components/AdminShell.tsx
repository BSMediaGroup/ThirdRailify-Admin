import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import boltMark from "../../assets/logos/boltv2.svg";
import { adminAreas } from "../config/navigation";
import { AdminIcon } from "./AdminIcon";

export function AdminShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const menuButton = useRef<HTMLButtonElement>(null);

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
          <div><strong>Development scaffold</strong><span>No privileged systems</span></div>
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
          <p><strong>Read-only by design</strong><span>Auth and writes are deferred.</span></p>
        </div>
      </aside>

      {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <div className="admin-workspace">
        <header className="topbar">
          <button ref={menuButton} className="icon-button menu-button" type="button" aria-expanded={mobileOpen} aria-controls="admin-sidebar" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} onClick={() => setMobileOpen((value) => !value)}>
            <AdminIcon name={mobileOpen ? "close" : "menu"} />
          </button>
          <div className="topbar-title"><span>Admin /</span><strong>{currentArea?.shortLabel ?? "Not found"}</strong></div>
          <div className="topbar-status"><span className="status-dot" aria-hidden="true" /><span>Scaffold only</span></div>
        </header>
        <main id="admin-main" className="admin-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
