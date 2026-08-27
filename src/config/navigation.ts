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
    summary: "Provider-neutral catalogue authority with synchronization disabled.",
    futureScope: ["Product source adapters", "Catalogue validation", "Safe provider write boundary"],
  },
  {
    path: "/orders",
    label: "Orders",
    shortLabel: "Orders",
    icon: "orders",
    summary: "Commerce order authority with no synthetic records.",
    futureScope: ["Server-side order access", "Fulfillment status", "Audited operational actions"],
  },
  {
    path: "/commerce",
    label: "Commerce Overview",
    shortLabel: "Commerce",
    icon: "overview",
    summary: "Stripe-first Canadian commerce posture and readiness.",
    futureScope: ["Separate commerce D1", "Provider truth", "Safe activation gates"],
  },
  {
    path: "/commerce/payments",
    label: "Payments & Payouts",
    shortLabel: "Payments",
    icon: "orders",
    summary: "Stripe Connect ownership, checkout, and payout posture.",
    futureScope: ["Hosted onboarding", "Direct charges", "Merchant-owned payouts"],
  },
  {
    path: "/commerce/business",
    label: "Business Information",
    shortLabel: "Business",
    icon: "content",
    summary: "Public and encrypted private Canadian business details.",
    futureScope: ["Public storefront profile", "Encrypted legal details", "Controlled projections"],
  },
  {
    path: "/commerce/tax",
    label: "Tax & Documents",
    shortLabel: "Tax",
    icon: "settings",
    summary: "Tax identifier custody and document presentation.",
    futureScope: ["Encrypted identifiers", "Invoice presentation", "Receipt presentation"],
  },
  {
    path: "/commerce/emails",
    label: "Customer Emails",
    shortLabel: "Emails",
    icon: "content",
    summary: "Structured customer lifecycle templates without sending.",
    futureScope: ["Bounded plain text", "Safe CTA fields", "Approval before delivery"],
  },
  {
    path: "/commerce/fulfillment",
    label: "Fulfillment Integrations",
    shortLabel: "Fulfillment",
    icon: "integrations",
    summary: "Printful draft-only planning and adapter boundaries.",
    futureScope: ["Manual/API store", "Draft orders", "Explicit confirmation gates"],
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
