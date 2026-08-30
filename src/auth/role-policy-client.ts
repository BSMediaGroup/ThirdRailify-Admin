import { adminApi } from "./client";
import type { AdminCapability } from "./capabilities";

export type RolePolicyCapability = { id: AdminCapability; group: string; label: string; description: string; mutable: boolean; masterOnly: boolean; effective: boolean; state: "default" | "restricted" | "required" | "master_only" };
export type RolePolicyPayload = {
  ok: true; targetRole: "full"; access: { isAdmin: boolean; isMasterAdmin: boolean; capabilities: string[] };
  groups: Array<{ id: string; label: string; description: string }>;
  capabilities: RolePolicyCapability[]; deniedCapabilities: AdminCapability[]; restrictedCount: number; canManage: boolean; checkedAt: string;
};

export const getRolePolicy = () => adminApi<RolePolicyPayload>("/api/admin/role-permissions");
export const saveRolePolicy = (csrfToken: string, deniedCapabilities: AdminCapability[]) => adminApi<RolePolicyPayload>("/api/admin/role-permissions", { method: "PUT", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ targetRole: "full", deniedCapabilities }) });
export const resetRolePolicy = (csrfToken: string) => adminApi<RolePolicyPayload>("/api/admin/role-permissions/reset", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: JSON.stringify({ confirmation: "RESET FULL ADMIN PERMISSIONS" }) });

