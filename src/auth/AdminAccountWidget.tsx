import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { AdminIcon } from "../components/AdminIcon";
import { useAuth } from "./AuthProvider";
import type { AuthAccount } from "./types";

export function AdminAccountWidget() {
  const { account, signOut } = useAuth(); const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") { setOpen(false); return; }
      if (event instanceof MouseEvent && root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  if (!account) return null;
  const accessLabel = account.adminLevel === "master" ? "Master Admin" : "Full Admin";
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") { event.preventDefault(); controls[(index + 1 + controls.length) % controls.length]?.focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); controls[(index - 1 + controls.length) % controls.length]?.focus(); }
    if (event.key === "Home") { event.preventDefault(); controls[0]?.focus(); }
    if (event.key === "End") { event.preventDefault(); controls.at(-1)?.focus(); }
  };
  return <div className="admin-account" ref={root}>
    <button className="admin-account__trigger" type="button" onClick={() => setOpen((value) => !value)} aria-label={`${account.displayName} account menu`} aria-haspopup="menu" aria-expanded={open}>
      <AdminAvatar account={account} /><span><strong>{account.displayName}</strong><small>{accessLabel.toUpperCase()}</small></span><b aria-hidden="true">&#9662;</b>
    </button>
    {open && <div className="admin-account__menu" role="menu" aria-label="Admin account menu" onKeyDown={handleMenuKeyDown}>
      <div className="admin-account__identity">
        <AdminAvatar account={account} />
        <div><strong>{account.displayName}</strong><span>{account.email || (account.username ? `@${account.username}` : "Third Railify account")}</span><small>{accessLabel}</small></div>
      </div>
      <dl className="admin-account__overview">
        <div><dt>Display name</dt><dd>{account.displayName}</dd></div>
        <div><dt>Email</dt><dd>{account.email || "Not supplied"}</dd></div>
        <div><dt>Account type</dt><dd>{account.role.toUpperCase()}</dd></div>
        <div><dt>Access</dt><dd>{accessLabel}</dd></div>
      </dl>
      <div className="admin-account__actions">
        <Link to="/access" role="menuitem" onClick={() => setOpen(false)}><AdminIcon name="profile" size={17} /><span>Account / Access</span></Link>
        <Link to="/settings" role="menuitem" onClick={() => setOpen(false)}><AdminIcon name="settings" size={17} /><span>Settings</span></Link>
        <span className="admin-account__divider" role="separator" />
        <a href="https://thirdrailify.com" role="menuitem"><AdminIcon name="external" size={17} /><span>Open public site</span></a>
        <button className="admin-account__logout" type="button" role="menuitem" onClick={() => { setOpen(false); void signOut(); }}><AdminIcon name="logout" size={17} /><span>Sign out</span></button>
      </div>
    </div>}
  </div>;
}

export function AdminAvatar({ account }: { account: Pick<AuthAccount, "avatarUrl" | "displayName"> }) {
  return account.avatarUrl ? <img className="admin-avatar" src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="admin-avatar admin-avatar--initial" aria-hidden="true">{account.displayName.trim().charAt(0).toUpperCase() || "T"}</span>;
}
