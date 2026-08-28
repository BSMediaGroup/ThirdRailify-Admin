import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import boltMark from "../../assets/logos/boltv2straight.svg";
import { adminAreas } from "../config/navigation";
import { AdminIcon } from "./AdminIcon";
import { AdminAccountWidget } from "../auth/AdminAccountWidget";
import { useAuth } from "../auth/AuthProvider";
import { getInboxSummary, type InboxSummary } from "../inbox/client";

export type AdminShellOutletContext = {
  startLoading: (reason?: string) => () => void;
  inboxSummary: InboxSummary | null;
  refreshInbox: () => Promise<void>;
};

const topLevelAdminAreas = adminAreas.filter((area) => !area.parentPath);
const childAdminAreas = (parentPath: string) => adminAreas.filter((area) => area.parentPath === parentPath);
const groupIsActive = (parentPath: string, pathname: string) => pathname === parentPath || pathname.startsWith(`${parentPath}/`) || childAdminAreas(parentPath).some((child) => pathname === child.path || pathname.startsWith(`${child.path}/`));

export function AdminShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { account } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarPreference);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(topLevelAdminAreas.filter((area) => groupIsActive(area.path, location.pathname)).map((area) => area.path)));
  const [loadingReason, setLoadingReason] = useState("");
  const [inboxSummary, setInboxSummary] = useState<InboxSummary | null>(null);
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

  const refreshInbox = useCallback(async () => {
    if (!account) { setInboxSummary(null); return; }
    try { setInboxSummary(await getInboxSummary()); }
    catch { setInboxSummary(null); }
  }, [account]);

  useEffect(() => {
    void refreshInbox();
    const interval = window.setInterval(() => void refreshInbox(), 60_000);
    return () => window.clearInterval(interval);
  }, [refreshInbox]);

  useEffect(() => { void refreshInbox(); }, [location.pathname, refreshInbox]);

  useEffect(() => {
    setMobileOpen(false);
    const activeGroup = topLevelAdminAreas.find((area) => childAdminAreas(area.path).length && groupIsActive(area.path, location.pathname));
    if (activeGroup) setOpenGroups((current) => current.has(activeGroup.path) ? current : new Set([...current, activeGroup.path]));
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    const canonical = adminAreas.find((area) => area.path.toLowerCase() === location.pathname.toLowerCase())?.path;
    if (canonical && canonical !== location.pathname) navigate(`${canonical}${location.search}${location.hash}`, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

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

  const currentArea = adminAreas.find((area) => area.path.toLowerCase() === location.pathname.toLowerCase())
    ?? (location.pathname.startsWith("/goats/") ? adminAreas.find((area) => area.path === "/goats") : undefined);

  const badgeFor = (path: string) => {
    if (!inboxSummary) return 0;
    if (path === "/inbox") return inboxSummary.unread;
    if (path === "/goats") return inboxSummary.actionable.goats.total;
    if (path === "/goats/pending") return inboxSummary.actionable.goats.submissions;
    if (path === "/goats/comments") return inboxSummary.actionable.goats.comments;
    if (path === "/goats/emails") return inboxSummary.actionable.goats.emailFailures;
    return 0;
  };

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
          {topLevelAdminAreas.map((area) => {
            const children = childAdminAreas(area.path);
            if (!children.length) return <NavLink key={area.path} to={area.path} end={area.path === "/"} aria-label={area.label} title={collapsed ? area.label : undefined} className={({ isActive }) => isActive ? "nav-link nav-link--active" : "nav-link"}>
              <AdminIcon name={area.icon} />
              <span>{area.label}</span>
              {badgeFor(area.path) ? <b className="nav-badge" aria-label={`${badgeFor(area.path)} unread`}>{formatBadge(badgeFor(area.path))}</b> : null}
            </NavLink>;
            const active = groupIsActive(area.path, location.pathname);
            const open = openGroups.has(area.path);
            const controlId = `${area.shortLabel.toLowerCase()}-navigation`;
            return <div key={area.path} className={`nav-group${open ? " nav-group--open" : ""}${active ? " nav-group--active" : ""}`}>
              <div className="nav-group__row">
                <NavLink to={area.path} end aria-label={area.label} title={collapsed ? area.label : undefined} className={({ isActive }) => isActive ? "nav-link nav-link--active" : "nav-link"}>
                  <AdminIcon name={area.icon} />
                  <span>{area.label}</span>
                  {badgeFor(area.path) ? <b className="nav-badge" aria-label={`${badgeFor(area.path)} items need attention`}>{formatBadge(badgeFor(area.path))}</b> : null}
                </NavLink>
                <button className="nav-group__toggle" type="button" aria-expanded={open} aria-controls={controlId} aria-label={`${open ? "Collapse" : "Expand"} ${area.shortLabel} navigation`} onClick={() => setOpenGroups((current) => { const next = new Set(current); if (next.has(area.path)) next.delete(area.path); else next.add(area.path); return next; })}>
                  <AdminIcon name="chevron" size={15} />
                </button>
              </div>
              <div id={controlId} className="nav-group__children" hidden={!open}>
                {children.map((child) => (
                  <NavLink key={child.path} to={child.path} aria-label={child.label} className={({ isActive }) => isActive ? "nav-link nav-link--nested nav-link--active" : "nav-link nav-link--nested"}>
                    <AdminIcon name={child.icon} size={17} />
                    <span>{child.label}</span>
                    {badgeFor(child.path) ? <b className="nav-badge nav-badge--nested" aria-label={`${badgeFor(child.path)} items need attention`}>{formatBadge(badgeFor(child.path))}</b> : null}
                  </NavLink>
                ))}
              </div>
            </div>;
          })}
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
          <AdminAccountWidget unreadCount={inboxSummary?.unread || 0} />
          <div className={`admin-shell-loading${loadingReason ? " is-active" : ""}`} role="status" aria-live="polite" aria-hidden={!loadingReason} aria-label={loadingReason || "Idle"}>
            <span className="admin-shell-loading__track" aria-hidden="true" />
            <span className="admin-shell-loading__bar" aria-hidden="true" />
          </div>
        </header>
        <main id="admin-main" className="admin-main" tabIndex={-1} aria-busy={Boolean(loadingReason)}>
          <Outlet context={{ startLoading, inboxSummary, refreshInbox }} />
        </main>
      </div>
    </div>
  );
}

function formatBadge(value: number) { return value > 99 ? "99+" : String(value); }

function readSidebarPreference() {
  try { return window.localStorage.getItem("thirdrailify.admin.sidebar") === "collapsed"; }
  catch { return false; }
}
