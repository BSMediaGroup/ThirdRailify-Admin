import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
  return <div className="admin-account" ref={root}>
    <button className="admin-account__trigger" type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}>
      <AdminAvatar account={account} /><span><strong>{account.displayName}</strong><small>{account.adminLevel === "master" ? "MASTER ADMIN" : "ADMIN"}</small></span><b aria-hidden="true">&#9662;</b>
    </button>
    {open && <div className="admin-account__menu" role="menu">
      <Link to="/access" role="menuitem" onClick={() => setOpen(false)}>Account / Access</Link>
      <a href="https://thirdrailify.com" role="menuitem">Open public site</a>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); void signOut(); }}>Sign out</button>
    </div>}
  </div>;
}

export function AdminAvatar({ account }: { account: Pick<AuthAccount, "avatarUrl" | "displayName"> }) {
  return account.avatarUrl ? <img className="admin-avatar" src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="admin-avatar admin-avatar--initial" aria-hidden="true">{account.displayName.trim().charAt(0).toUpperCase() || "T"}</span>;
}
