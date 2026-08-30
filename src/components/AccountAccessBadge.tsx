/* eslint-disable react-refresh/only-export-components -- badge and role chips share one presentation-only role contract. */
import type { AuthAccount } from "../auth/types";

export type AccountAccessKind = "master_admin" | "full_admin" | "regular_user";

export function normalizeAccountAccess(account: Pick<AuthAccount, "role" | "adminLevel">): AccountAccessKind {
  if (account.role === "admin" && account.adminLevel === "master") return "master_admin";
  if (account.role === "admin" && account.adminLevel === "full") return "full_admin";
  return "regular_user";
}

export function accountAccessLabel(value: AccountAccessKind) {
  return value === "master_admin" ? "Master Admin" : value === "full_admin" ? "Full Admin" : "Regular User";
}

export function AccountAccessBadge({ account }: { account: Pick<AuthAccount, "role" | "adminLevel"> }) {
  const kind = normalizeAccountAccess(account);
  const label = accountAccessLabel(kind);
  return <span className={`account-access-badge account-access-badge--${kind}`} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {kind === "regular_user" ? <>
        <path className="account-access-badge__verified" d="m12 2.8 2.2 1.3 2.5-.1 1.2 2.2 2.2 1.2-.1 2.5 1.3 2.1-1.3 2.1.1 2.5-2.2 1.2-1.2 2.2-2.5-.1-2.2 1.3-2.2-1.3-2.5.1-1.2-2.2-2.2-1.2.1-2.5L2.7 12 4 9.9l-.1-2.5 2.2-1.2L7.3 4l2.5.1L12 2.8Z" />
        <path className="account-access-badge__mark" d="m8.4 12.2 2.3 2.3 5-5.1" />
      </> : <>
        <path className="account-access-badge__shield" d="M12 2.8 20 6v5.1c0 5-3.3 8.8-8 10.1-4.7-1.3-8-5.1-8-10.1V6l8-3.2Z" />
        {kind === "master_admin" ? <path className="account-access-badge__mark" d="m13.8 6.4-5 6.2h3l-1.4 5 5.2-6.6h-3.1l1.3-4.6Z" /> : <path className="account-access-badge__mark" d="m8.5 12.2 2.2 2.2 4.8-5" />}
      </>}
    </svg>
  </span>;
}

export function AccountRoleChip({ account }: { account: Pick<AuthAccount, "role" | "adminLevel"> }) {
  const kind = normalizeAccountAccess(account);
  return <span className={`account-role-chip account-role-chip--${kind}`}>{accountAccessLabel(kind)}</span>;
}
