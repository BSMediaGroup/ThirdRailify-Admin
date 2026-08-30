export const adminCapabilityIds = [
  "overview.view", "analytics.view", "inbox.view", "inbox.manage", "watch.view", "watch.manage",
  "content.view", "content.manage", "commerce.view", "commerce.catalogue.manage", "commerce.business.manage",
  "commerce.payments.manage", "commerce.integrations.manage", "commerce.templates.manage", "commerce.operations.manage",
  "wheels.view", "wheels.manage", "media.view", "goats.view", "goats.manage",
  "membership.view", "users.view", "users.manage", "integrations.view",
  "settings.view", "settings.manage", "role_permissions.view", "role_permissions.manage",
] as const;

export type AdminCapability = typeof adminCapabilityIds[number];

export type AdminRoutePolicy = { view: AdminCapability; manage?: AdminCapability };

const policies: Record<string, AdminRoutePolicy> = {
  "/": { view: "overview.view" },
  "/analytics": { view: "analytics.view" },
  "/inbox": { view: "inbox.view", manage: "inbox.manage" },
  "/watch": { view: "watch.view", manage: "watch.manage" },
  "/content": { view: "content.view", manage: "content.manage" },
  "/shop": { view: "commerce.view" },
  "/products": { view: "commerce.view", manage: "commerce.catalogue.manage" },
  "/collections": { view: "commerce.view", manage: "commerce.catalogue.manage" },
  "/orders": { view: "commerce.view" },
  "/customers": { view: "commerce.view" },
  "/commerce": { view: "commerce.view", manage: "commerce.operations.manage" },
  "/commerce/payments": { view: "commerce.view", manage: "commerce.payments.manage" },
  "/commerce/analytics": { view: "commerce.view" },
  "/commerce/business": { view: "commerce.view", manage: "commerce.business.manage" },
  "/commerce/tax": { view: "commerce.view" },
  "/commerce/emails": { view: "commerce.view", manage: "commerce.templates.manage" },
  "/commerce/fulfillment": { view: "commerce.view", manage: "commerce.operations.manage" },
  "/wheels": { view: "wheels.view", manage: "wheels.manage" },
  "/wheels/stages": { view: "wheels.view", manage: "wheels.manage" },
  "/wheels/access": { view: "wheels.view", manage: "wheels.manage" },
  "/wheels/results": { view: "wheels.view", manage: "wheels.manage" },
  "/media": { view: "media.view" },
  "/goats": { view: "goats.view", manage: "goats.manage" },
  "/goats/pending": { view: "goats.view", manage: "goats.manage" },
  "/goats/approved": { view: "goats.view", manage: "goats.manage" },
  "/goats/rejected": { view: "goats.view", manage: "goats.manage" },
  "/goats/comments": { view: "goats.view", manage: "goats.manage" },
  "/goats/settings": { view: "goats.view", manage: "goats.manage" },
  "/goats/emails": { view: "goats.view", manage: "goats.manage" },
  "/membership": { view: "membership.view" },
  "/access": { view: "users.view", manage: "users.manage" },
  "/integrations": { view: "integrations.view" },
  "/settings": { view: "role_permissions.view", manage: "settings.manage" },
};

export function adminRoutePolicy(path: string): AdminRoutePolicy {
  if (path.startsWith("/wheels/")) return policies["/wheels"];
  if (path.startsWith("/goats/")) return policies["/goats"];
  return policies[path] || { view: "overview.view" };
}
