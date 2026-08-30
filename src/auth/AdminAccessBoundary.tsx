import type { ReactNode } from "react";
import boltMark from "../../assets/logos/boltv2straight.svg";
import { useAuth } from "./AuthProvider";

export function AdminAccessBoundary({ children }: { children: ReactNode }) {
  const { loading, account, access, error, openAuth, signOut, openPublicSite } = useAuth();
  if (loading) return <AccessFrame title="Checking access" detail="Resolving the current server session and role." busy />;
  if (!account) return <AccessFrame title="Restricted access" detail={error || "Sign in with your Third Railify account. The server will verify Admin access before the control room loads."} action="Sign in" onAction={() => openAuth("signin")} />;
  if (!access.isAdmin) return <AccessFrame title="Admin access required" detail={`${account.displayName}, your account is active but does not have an Admin role.`} identity={account.email || account.username || account.displayName} action="Sign out" onAction={() => void signOut()} link="Go to Third Railify" onLink={() => void openPublicSite("/")} />;
  return <>{children}</>;
}

function AccessFrame({ title, detail, busy = false, identity, action, onAction, link, onLink }: { title: string; detail: string; busy?: boolean; identity?: string; action?: string; onAction?: () => void; link?: string; onLink?: () => void }) {
  return <main className="access-gate"><section className="access-gate__panel" aria-labelledby="access-title">
    <div className="access-gate__brand"><span><img src={boltMark} alt="" /></span><div><strong>THIRD RAILIFY</strong><small>CONTROL ROOM</small></div></div>
    <p className="eyebrow"><span /> Account authority</p><h1 id="access-title">{title}</h1><p>{detail}</p>
    {identity && <div className="access-gate__identity">Signed in as <strong>{identity}</strong></div>}
    {busy && <div className="access-gate__progress" role="status"><span /> Secure session check</div>}
    {(action || link) && <div className="access-gate__actions">{link && <a href="https://thirdrailify.com" onClick={(event) => { event.preventDefault(); onLink?.(); }}>{link}</a>}{action && <button type="button" onClick={onAction}>{action}</button>}</div>}
  </section></main>;
}
