export type AdminArea = {
  path: string;
  label: string;
  shortLabel: string;
  icon: "overview" | "content" | "products" | "orders" | "media" | "vip" | "users" | "integrations" | "settings";
  summary: string;
  futureScope: string[];
};

export const adminAreas: AdminArea[] = [
  {
    path: "/",
    label: "Overview",
    shortLabel: "Overview",
    icon: "overview",
    summary: "Scaffold posture and implementation boundaries.",
    futureScope: ["Authenticated system health", "Approval queues", "Owned operational metrics"],
  },
  {
    path: "/content",
    label: "Site Content",
    shortLabel: "Content",
    icon: "content",
    summary: "Future editorial content and migration workflow.",
    futureScope: ["Versioned drafts", "Review and publish controls", "Public-site content API"],
  },
  {
    path: "/products",
    label: "Shop / Products",
    shortLabel: "Products",
    icon: "products",
    summary: "Future provider-neutral catalogue operations.",
    futureScope: ["Product source adapters", "Catalogue validation", "Safe provider write boundary"],
  },
  {
    path: "/orders",
    label: "Orders",
    shortLabel: "Orders",
    icon: "orders",
    summary: "Future read-only order operations and fulfillment views.",
    futureScope: ["Server-side order access", "Fulfillment status", "Audited operational actions"],
  },
  {
    path: "/media",
    label: "Media",
    shortLabel: "Media",
    icon: "media",
    summary: "Future managed brand and editorial asset library.",
    futureScope: ["Asset inventory", "Usage metadata", "Approved upload pipeline"],
  },
  {
    path: "/membership",
    label: "VIP / Membership",
    shortLabel: "VIP",
    icon: "vip",
    summary: "Future membership definitions and support workflow.",
    futureScope: ["Plan authority integration", "Benefit definitions", "Member support tools"],
  },
  {
    path: "/access",
    label: "Users / Access",
    shortLabel: "Access",
    icon: "users",
    summary: "Future identity, roles, sessions, and audit posture.",
    futureScope: ["Real authentication", "Least-privilege roles", "Session and audit controls"],
  },
  {
    path: "/integrations",
    label: "Integrations",
    shortLabel: "Integrations",
    icon: "integrations",
    summary: "Future server-side provider connection posture.",
    futureScope: ["Credential-safe configuration", "Connectivity diagnostics", "Provider capability gates"],
  },
  {
    path: "/settings",
    label: "Settings",
    shortLabel: "Settings",
    icon: "settings",
    summary: "Future organization-level configuration and safeguards.",
    futureScope: ["Validated configuration", "Change previews", "Revision-checked persistence"],
  },
];
