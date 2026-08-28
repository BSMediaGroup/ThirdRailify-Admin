import type { ReactNode } from "react";
import type { AdminArea } from "../config/navigation";

type Props = {
  name: AdminArea["icon"] | "menu" | "close" | "arrow" | "chevron" | "shield" | "signal" | "collapse" | "profile" | "external" | "logout" | "eye" | "eyeOff" | "star" | "edit" | "upload" | "link" | "trash" | "moveUp" | "moveDown";
  size?: number;
};

const paths: Record<Props["name"], ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  content: <><path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></>,
  watch: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/><path d="M6 2v3M18 2v3"/></>,
  products: <><path d="m4 7 8-4 8 4-8 4z"/><path d="m4 7 8 4 8-4v10l-8 4-8-4zM12 11v10"/></>,
  orders: <><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/></>,
  commerce: <><path d="M4 10v10h16V10M3 10l2-6h14l2 6"/><path d="M3 10c0 1.3 1 2 2.3 2s2.3-.7 2.3-2c0 1.3 1 2 2.3 2s2.3-.7 2.3-2c0 1.3 1 2 2.3 2s2.3-.7 2.3-2c0 1.3 1 2 2.3 2s2.3-.7 2.3-2M9 20v-5h6v5"/></>,
  payments: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></>,
  business: <><path d="M4 21V6l8-3 8 3v15M9 21v-4h6v4"/><path d="M8 8h2M14 8h2M8 12h2M14 12h2M3 21h18"/></>,
  tax: <><path d="M6 3h8l4 4v14H6zM14 3v5h4"/><circle cx="10" cy="12" r="1"/><circle cx="14" cy="17" r="1"/><path d="m15 11-6 7"/></>,
  emails: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  fulfillment: <><path d="M3 6h11v11H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,
  media: <><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 17 5-4 3 2 3-3 3 5"/></>,
  goats: <><path d="M7 9 4 5c-.7 2.8.1 5 2.4 6.3M17 9l3-4c.7 2.8-.1 5-2.4 6.3"/><path d="M7 9c1.2-2 2.9-3 5-3s3.8 1 5 3v5c0 3-2 6-5 6s-5-3-5-6z"/><path d="M9 13h.01M15 13h.01M10 17c1.3.7 2.7.7 4 0"/></>,
  pending: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  approved: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
  rejected: <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>,
  comments: <><path d="M4 5h16v12H9l-5 4z"/><path d="M8 9h8M8 13h5"/></>,
  vip: <><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3 20c.5-4 2.5-6 6-6s5.5 2 6 6M16 6h5M18.5 3.5v5"/></>,
  integrations: <><path d="M8 12h8M12 8v8"/><path d="M7 4h10v4h3v8h-3v4H7v-4H4V8h3z"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.3-2.6h-4L10.4 6A7 7 0 0 0 8 7.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1A7 7 0 0 0 10.4 18l.3 2.6h4L15 18a7 7 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/></>,
  wheels: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M18.4 5.6l-4.2 4.2M9.8 14.2l-4.2 4.2"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
  chevron: <><path d="m9 6 6 6-6 6"/></>,
  shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6zM9 12l2 2 4-5"/></>,
  signal: <><path d="M5 18h14M8 18l4-14 4 14M9.5 12h5M7 7 4 4M17 7l3-3"/></>,
  collapse: <><path d="m14 7-5 5 5 5"/><path d="M20 4v16"/></>,
  profile: <><circle cx="12" cy="8" r="3"/><path d="M5 21c.6-4.7 3-7 7-7s6.4 2.3 7 7"/></>,
  external: <><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v6H5V6h6"/></>,
  logout: <><path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/></>,
  eyeOff: <><path d="M3 3l18 18M10.6 6.1A10.5 10.5 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 3M6.6 6.7C4 8.3 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3-.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
  star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13.5 6.5 4 4M4 20h16"/></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 14v6h14v-6"/></>,
  link: <><path d="m10 13 4-4"/><path d="M7.5 15.5 5 18a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0" transform="translate(2 -1)"/><path d="m16.5 8.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" transform="translate(-2 1)"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
  moveUp: <><path d="M12 19V5M7 10l5-5 5 5"/></>,
  moveDown: <><path d="M12 5v14M7 14l5 5 5-5"/></>,
};

export function AdminIcon({ name, size = 20 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
