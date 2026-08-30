import {
  AuthFailure,
  cleanText,
  nowIso,
  requireAdmin,
  requireAuthDb,
  writeAudit,
} from "./auth-core.js";

const definition = (id, group, label, description, options = {}) => Object.freeze({
  id,
  group,
  label,
  description,
  mutable: options.mutable !== false,
  masterOnly: Boolean(options.masterOnly),
});

export const ADMIN_CAPABILITIES = Object.freeze([
  definition("overview.view", "overview", "View Overview", "View cross-system Admin posture and operational summaries."),
  definition("analytics.view", "analytics", "View audience analytics", "View privacy-minimized audience reporting and revenue signals."),
  definition("inbox.view", "inbox", "View Admin Inbox", "Read Admin notices, delivery alerts, and actionable queues."),
  definition("inbox.manage", "inbox", "Manage Admin Inbox", "Mark, restore, and remove Admin inbox messages."),
  definition("watch.view", "watch", "View Watch archive", "Inspect retained broadcast and episode authority."),
  definition("watch.manage", "watch", "Manage Watch archive", "Show or hide retained Watch episodes."),
  definition("content.view", "content", "View site content", "Inspect public announcement and Live Now presentation settings."),
  definition("content.manage", "content", "Manage site content", "Change public announcement and Live Now presentation settings."),
  definition("commerce.view", "commerce", "View shop and commerce", "View products, collections, orders, customers, payments, and commerce intelligence."),
  definition("commerce.catalogue.manage", "commerce", "Manage products and collections", "Manage storefront products, media, collections, and merchandising."),
  definition("commerce.business.manage", "commerce", "Manage business and tax", "Manage merchant information and tax-registration custody."),
  definition("commerce.payments.manage", "commerce", "Manage payments", "Run protected payment verification and payment-control operations."),
  definition("commerce.integrations.manage", "commerce", "Manage commerce integrations", "Run protected Printful and commerce-provider operations."),
  definition("commerce.templates.manage", "commerce", "Manage customer documents and emails", "Manage customer email, receipt, and invoice templates."),
  definition("commerce.operations.manage", "commerce", "Manage commerce operations", "Run protected launch, checkout, order, and fulfillment operations."),
  definition("wheels.view", "wheels", "View Wheels", "Inspect Wheels, Stages, access assignments, settings, and official results."),
  definition("wheels.manage", "wheels", "Manage Wheels", "Manage Wheel lifecycle, access, settings, media, Stages, and official results."),
  definition("media.view", "media", "View media", "Inspect the sanitized cross-workspace media inventory."),
  definition("goats.view", "goats", "View GOATS", "Inspect GOATS submissions, comments, settings, media, and delivery state."),
  definition("goats.manage", "goats", "Manage GOATS", "Moderate GOATS content, media, interactions, templates, and delivery retries."),
  definition("membership.view", "membership", "View VIP and membership", "Inspect membership and entitlement readiness."),
  definition("users.view", "users", "View users and access", "Inspect accounts, identities, roles, sessions, and audit posture."),
  definition("users.manage", "users", "Manage users and access", "Promote Full Admins and manage ordinary account state and sessions."),
  definition("integrations.view", "integrations", "View integrations", "Inspect credential-safe provider and integration status."),
  definition("settings.view", "settings", "View settings", "Inspect global and feature-owned settings authorities."),
  definition("settings.manage", "settings", "Manage settings", "Use available global and feature-owned settings controls."),
  definition("role_permissions.view", "role_permissions", "View role permissions", "Inspect the effective Full Admin permission policy.", { mutable: false }),
  definition("role_permissions.manage", "role_permissions", "Manage role permissions", "Change Full Admin capability restrictions.", { mutable: false, masterOnly: true }),
]);

export const ADMIN_CAPABILITY_IDS = Object.freeze(ADMIN_CAPABILITIES.map((item) => item.id));
export const ADMIN_CAPABILITY_SET = new Set(ADMIN_CAPABILITY_IDS);
const MUTABLE_FULL_ADMIN_CAPABILITIES = new Set(ADMIN_CAPABILITIES.filter((item) => item.mutable && !item.masterOnly).map((item) => item.id));

export const ADMIN_CAPABILITY_GROUPS = Object.freeze([
  { id: "overview", label: "Overview", description: "Cross-system operational posture." },
  { id: "analytics", label: "Audience Analytics", description: "Privacy-minimized audience reporting." },
  { id: "inbox", label: "Admin Inbox", description: "Internal notices and action queues." },
  { id: "watch", label: "Watch / Broadcast", description: "Broadcast archive visibility and controls." },
  { id: "content", label: "Site Content", description: "Public announcement presentation." },
  { id: "commerce", label: "Shop & Commerce", description: "Products, orders, customers, finance, and operations." },
  { id: "wheels", label: "Wheels", description: "Wheel, Stage, access, and official-result authority." },
  { id: "media", label: "Media", description: "Admin-owned media inventory and actions." },
  { id: "goats", label: "GOATS in the Wild", description: "Community moderation and communications." },
  { id: "membership", label: "VIP / Membership", description: "Membership and entitlement controls." },
  { id: "users", label: "Users / Access", description: "Account roles, state, sessions, and audit." },
  { id: "integrations", label: "Integrations", description: "Provider configuration and operations." },
  { id: "settings", label: "Settings", description: "Global and feature-owned settings." },
  { id: "role_permissions", label: "Role Permissions & Scopes", description: "Master-owned Full Admin policy." },
]);

export function isRegisteredAdminCapability(capability) {
  return ADMIN_CAPABILITY_SET.has(String(capability || ""));
}

export async function effectiveAdminAccess(env, account) {
  const isAdmin = Boolean(account && account.role === "admin" && account.status === "active");
  const isMasterAdmin = Boolean(isAdmin && account.adminLevel === "master");
  if (!isAdmin) return { isAdmin: false, isMasterAdmin: false, capabilities: [] };
  if (isMasterAdmin) return { isAdmin: true, isMasterAdmin: true, capabilities: [...ADMIN_CAPABILITY_IDS] };
  if (account.adminLevel !== "full") return { isAdmin: true, isMasterAdmin: false, capabilities: [] };

  const denied = await readFullAdminDenials(env);
  const capabilities = ADMIN_CAPABILITIES
    .filter((item) => !item.masterOnly && (!item.mutable || !denied.has(item.id)))
    .map((item) => item.id);
  return { isAdmin: true, isMasterAdmin: false, capabilities };
}

export async function accessForSession(env, session) {
  if (!session) return { isAdmin: false, isMasterAdmin: false, capabilities: [] };
  const account = session.account && !session.account.role && new Set(["full", "master"]).has(session.account.adminLevel)
    ? { ...session.account, role: "admin", status: "active" }
    : session.account;
  if (!session.adminAccess) session.adminAccess = await effectiveAdminAccess(env, account);
  return session.adminAccess;
}

export async function requireAdminCapability(env, requestOrSession, capability) {
  if (!isRegisteredAdminCapability(capability)) {
    throw new AuthFailure(403, "unknown_admin_capability", "The requested Admin capability is not registered.");
  }
  const session = requestOrSession instanceof Request ? await requireAdmin(env, requestOrSession) : requestOrSession;
  const access = await accessForSession(env, session);
  if (!access.capabilities.includes(capability)) {
    throw new AuthFailure(403, "admin_capability_restricted", "This capability has been restricted by Master Admin.");
  }
  return session;
}

export async function rolePolicyPayload(env, session) {
  await requireAdminCapability(env, session, "role_permissions.view");
  const access = await accessForSession(env, session);
  const denied = await readFullAdminDenials(env);
  return {
    ok: true,
    targetRole: "full",
    access,
    groups: ADMIN_CAPABILITY_GROUPS,
    capabilities: ADMIN_CAPABILITIES.map((item) => ({
      ...item,
      effective: item.id === "role_permissions.manage" ? false : !denied.has(item.id),
      state: item.id === "role_permissions.manage" ? "master_only" : item.mutable && denied.has(item.id) ? "restricted" : item.mutable ? "default" : "required",
    })),
    deniedCapabilities: [...denied].filter((id) => MUTABLE_FULL_ADMIN_CAPABILITIES.has(id)).sort(),
    restrictedCount: [...denied].filter((id) => MUTABLE_FULL_ADMIN_CAPABILITIES.has(id)).length,
    canManage: access.capabilities.includes("role_permissions.manage"),
    checkedAt: nowIso(),
  };
}

export async function replaceFullAdminDenials(env, session, input) {
  await requireAdminCapability(env, session, "role_permissions.manage");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidPolicy();
  const keys = Object.keys(input);
  if (keys.some((key) => !new Set(["targetRole", "deniedCapabilities"]).has(key))) throw invalidPolicy();
  if (("targetRole" in input && input.targetRole !== "full") || !Array.isArray(input.deniedCapabilities)) throw invalidPolicy();
  if (input.deniedCapabilities.length > MUTABLE_FULL_ADMIN_CAPABILITIES.size) throw invalidPolicy();
  const desired = new Set();
  for (const rawCapability of input.deniedCapabilities) {
    const capability = cleanText(rawCapability, 100);
    if (!MUTABLE_FULL_ADMIN_CAPABILITIES.has(capability)) {
      throw new AuthFailure(400, "invalid_capability", "Only registered delegable Full Admin capabilities may be restricted.");
    }
    desired.add(capability);
  }
  const current = await readFullAdminDenials(env);
  const added = [...desired].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => MUTABLE_FULL_ADMIN_CAPABILITIES.has(id) && !desired.has(id));
  const timestamp = nowIso();
  const db = requireAuthDb(env);
  const statements = [
    ...added.map((capability) => db.prepare(`INSERT INTO admin_role_capability_denials
      (role, capability, denied_by_account_id, created_at, updated_at) VALUES ('full', ?, ?, ?, ?)
      ON CONFLICT(role, capability) DO UPDATE SET denied_by_account_id=excluded.denied_by_account_id, updated_at=excluded.updated_at`)
      .bind(capability, session.accountId, timestamp, timestamp)),
    ...removed.map((capability) => db.prepare("DELETE FROM admin_role_capability_denials WHERE role='full' AND capability=?").bind(capability)),
  ];
  if (statements.length) await db.batch(statements);
  for (const capability of added) await auditPolicyChange(env, session.accountId, capability, true, false);
  for (const capability of removed) await auditPolicyChange(env, session.accountId, capability, false, true);
  session.adminAccess = null;
  return rolePolicyPayload(env, session);
}

export async function resetFullAdminDenials(env, session) {
  await requireAdminCapability(env, session, "role_permissions.manage");
  const current = await readFullAdminDenials(env);
  const removed = [...current].filter((id) => MUTABLE_FULL_ADMIN_CAPABILITIES.has(id));
  if (removed.length) await requireAuthDb(env).prepare("DELETE FROM admin_role_capability_denials WHERE role='full'").run();
  for (const capability of removed) await auditPolicyChange(env, session.accountId, capability, false, true, "reset_to_defaults");
  session.adminAccess = null;
  return rolePolicyPayload(env, session);
}

async function readFullAdminDenials(env) {
  try {
    const result = await requireAuthDb(env).prepare("SELECT capability FROM admin_role_capability_denials WHERE role='full'").all();
    return new Set((result?.results || []).map((row) => String(row.capability || "")).filter((id) => MUTABLE_FULL_ADMIN_CAPABILITIES.has(id)));
  } catch (error) {
    if (/no such table:\s*admin_role_capability_denials/i.test(String(error?.message || error))) return new Set();
    throw error;
  }
}

async function auditPolicyChange(env, actorAccountId, capability, previousEffective, newEffective, operation = "policy_update") {
  await writeAudit(env, {
    actorAccountId,
    eventType: "full_admin_capability_policy_changed",
    result: "success",
    metadata: { targetRole: "full", capability, previousEffective, newEffective, operation },
  });
}

function invalidPolicy() {
  return new AuthFailure(400, "role_policy_invalid", "The Full Admin role policy request is invalid.");
}
