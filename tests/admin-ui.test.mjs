import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("GOATS is a first-class expandable sidebar group with relevant child icons", async () => {
  const [navigation, shell, icons] = await Promise.all([
    read("src/config/navigation.ts"),
    read("src/components/AdminShell.tsx"),
    read("src/components/AdminIcon.tsx"),
  ]);
  for (const [path, label, icon] of [
    ["/goats/pending", "Pending Submissions", "pending"],
    ["/goats/approved", "Approved & Published", "approved"],
    ["/goats/rejected", "Rejected Submissions", "rejected"],
    ["/goats/comments", "Comment Moderation", "comments"],
    ["/goats/emails", "GOATS Emails", "emails"],
  ]) {
    assert.match(navigation, new RegExp(`path: "${path.replaceAll("/", "\\/")}"[\\s\\S]{0,100}parentPath: "\\/goats"[\\s\\S]{0,140}label: "${label}"[\\s\\S]{0,100}icon: "${icon}"`));
  }
  assert.match(shell, /const childAdminAreas =/);
  assert.match(shell, /aria-controls=\{controlId\}/);
  assert.match(shell, /openGroups\.has\(area\.path\)/);
  for (const icon of ["goats", "pending", "approved", "rejected", "comments"]) assert.match(icons, new RegExp(`\\s${icon}: <`));
});

test("GOATS email workspace uses the branded Commerce-grade editor and sandboxed preview", async () => {
  const [page, styles, core] = await Promise.all([
    read("src/pages/GoatsAdminPages.tsx"),
    read("src/styles/global.css"),
    read("functions/_shared/goats-core.js"),
  ]);
  assert.match(page, /template-workspace goats-template-workspace/);
  assert.match(page, /className="commerce-form goats-email-form"/);
  assert.match(page, /className="email-template-preview"/);
  assert.match(page, /Sandboxed branded GOATS email preview/);
  assert.match(page, /sandbox="allow-same-origin"/);
  for (const font of ["American Captain", "Blinker", "Geist Mono"]) assert.match(page, new RegExp(`font-family:'${font.replace(" ", "\\s")}'`));
  assert.match(page, /View plain-text fallback/);
  assert.doesNotMatch(page, /srcDoc=\{fixturePreview\(draft\.htmlBody\)\}/);
  assert.match(styles, /\.goats-email-preview-frame/);
  assert.match(styles, /\.goats-email-variables code/);
  assert.match(core, /brandedGoatEmailHtml\(renderTemplate/);
  assert.match(core, /const assets = `\$\{assetOrigin\}\/email-assets`/);
  assert.match(core, /\$\{assets\}\/american-captain\.ttf/);
  assert.match(core, /\$\{assets\}\/blinker-regular\.ttf/);
  assert.match(core, /\$\{assets\}\/geist-mono\.ttf/);
  assert.match(core, /THIRD RAILIFY OFFICIAL/);
});

test("GOATS approved records expose durable content, media, and reaction reset controls", async () => {
  const [app, page, client, navigation] = await Promise.all([read("src/App.tsx"), read("src/pages/GoatsAdminPages.tsx"), read("src/goats/client.ts"), read("src/config/navigation.ts")]);
  assert.match(app, /path="goats\/reactions" element={<Navigate to="\/goats\/approved" replace/);
  assert.match(app, /path="goats\/settings"/);
  for (const label of ["Approved listings remain editable", "Add, replace, or remove images", "Reset all reactions", "Save global defaults"]) assert.match(page, new RegExp(label));
  assert.match(page, /media\.some\(\(media\) => media\.role === "profile"\)[\s\S]*Add profile/);
  assert.match(page, /media\.role === "profile" \? "image\/jpeg,image\/png,image\/webp,image\/gif"/);
  assert.match(client, /uploadGoatMedia/); assert.match(client, /deleteGoatMedia/); assert.match(client, /saveGoatSettings/); assert.match(client, /resetGoatReactions/);
  assert.doesNotMatch(navigation, /path: "\/goats\/reactions"/); assert.match(navigation, /path: "\/goats\/settings"/);
});

test("Admin inbox is linked from navigation, shell indicators, overview, and account menu", async () => {
  const [app, navigation, shell, account, overview, inbox, styles] = await Promise.all([read("src/App.tsx"), read("src/config/navigation.ts"), read("src/components/AdminShell.tsx"), read("src/auth/AdminAccountWidget.tsx"), read("src/pages/OverviewPage.tsx"), read("src/pages/InboxPage.tsx"), read("src/styles/global.css")]);
  assert.match(app, /path="inbox" element={<InboxPage/);
  assert.match(navigation, /path: "\/inbox"[\s\S]{0,100}label: "Admin Inbox"/);
  assert.match(shell, /actionable\.goats\.submissions/); assert.match(shell, /nav-badge/);
  assert.match(account, /Admin Inbox/); assert.match(account, /admin-account__badge/);
  assert.match(styles, /\.admin-account__actions button \{[^}]*justify-content: flex-start/);
  assert.match(overview, /Latest notices/); assert.match(overview, /Open full inbox/);
  assert.match(inbox, /Mark all read/); assert.match(inbox, /Unread only/);
});

test("Watch authority failures render unknown archive state instead of false zero counts", async () => {
  const page = await read("src/pages/WatchAdminPage.tsx");
  assert.match(page, /summary \? `\$\{summary\.retained\} \/ 24` : "— \/ 24"/);
  for (const field of ["retained", "visible", "hidden", "remaining"]) {
    assert.match(page, new RegExp(`summary\\?\\.${field} \\?\\? "—"`));
  }
  assert.match(page, /archiveUnavailable && <div className="watch-admin-empty">[\s\S]*Retained archive unavailable/);
  assert.match(page, /No zero counts are being inferred/);
  assert.doesNotMatch(page, /summary\?\.retained \?\? 0/);
  assert.doesNotMatch(page, /summary\?\.remaining \?\? 24/);
});

test("Site Content exposes separate normal and fixture-labelled Live Now configuration without a manual live-title field", async () => {
  const [app, page, client] = await Promise.all([read("src/App.tsx"), read("src/pages/SiteContentPage.tsx"), read("src/banner/client.ts")]);
  assert.match(app, /path="content" element={<SiteContentPage/);
  for (const label of ["Normal promo / info", "Homepage content rail", "Seamless marquee scroll", "Third Railify triple zap", "Automatic Live Now", "Presentation mode", "Animation speed", "Locked destination", "Fixture preview only", "Unsaved changes"]) assert.match(page, new RegExp(label));
  assert.match(page, /SAMPLE PREVIEW — Third Railify live broadcast title/);
  assert.match(page, /<code>\/watch\/live<\/code>/);
  assert.doesNotMatch(page, /Active stream title<\/span><input/);
  assert.match(client, /expectedRevision/);
  assert.match(client, /X-CSRF-Token/);
});

test("Overview is a fail-soft operational snapshot rather than a deferred foundation page", async () => {
  const [page, styles, navigation, scripts] = await Promise.all([read("src/pages/OverviewPage.tsx"), read("src/styles/global.css"), read("src/config/navigation.ts"), read("package.json")]);
  for (const authority of ["/api/admin/status", "getCommerceOverview", "manageWatch", "getGoatsOverview", "readBannerSettings"]) assert.match(page, new RegExp(authority.replaceAll("/", "\\/")));
  for (const label of ["Operational workspaces", "Runtime posture", "Operational priorities", "Recent GOATS", "Partial operational snapshot"]) assert.match(page, new RegExp(label));
  assert.match(page, /Missing values remain unavailable rather than being replaced with zero/);
  assert.match(page, /Master Admin access is required/);
  assert.match(page, /overview-pulse__credential/);
  assert.match(page, /Account level \/ server verified/);
  assert.match(page, /access\.isMasterAdmin \? "Master" : "Full Admin"/);
  assert.doesNotMatch(page, /Authenticated foundation|Still intentionally deferred|Products and orders remain provider-neutral shells/);
  assert.match(styles, /\.overview-module-grid/);
  assert.match(styles, /\.overview-pulse__shield::before/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.overview-hero::after/);
  assert.match(navigation, /summary: "Cross-system operational state, queues, and direct workspace routes\."/);
  assert.match(scripts, /"test:browser:overview"/);
});

test("Orders exposes only the Master-controlled Stripe TEST acceptance and truthful fulfillment state", async () => {
  const [page, client, core, route, shell] = await Promise.all([read("src/pages/CommercePages.tsx"), read("src/commerce/client.ts"), read("functions/_shared/checkout-core.js"), read("functions/api/admin/commerce/[[path]].js"), read("src/components/AdminShell.tsx")]);
  for (const label of ["TEST CHECKOUT · STRIPE SANDBOX · NO REAL CHARGE", "Generate Test Checkout", "Single acceptance Session already created", "Printful order", "Open Stripe TEST Checkout"]) assert.match(page, new RegExp(label));
  for (const label of ["STRIPE TEST ACCEPTANCE", "Signed payment acceptance", "Webhook", "Verified", "Test gate", "Closed"]) assert.match(page, new RegExp(label));
  assert.match(page, /access\.isMasterAdmin/); assert.match(client, /\/api\/admin\/commerce\/test-checkout/); assert.match(route, /requireMasterAdmin\(env, request\)/);
  assert.match(core, /gate === "controlled_test"/); assert.match(core, /stripe_test_checkout_already_created/); assert.match(core, /fulfillment_status = 'disabled'|fulfillment_status, currency_code/); assert.match(core, /webhookReceiptCount/); assert.match(core, /webhookVerified/);
  assert.match(shell, /area\.path\.toLowerCase\(\) === location\.pathname\.toLowerCase\(\)/); assert.match(shell, /navigate\(`\$\{canonical\}/);
});

test("Shop is an expandable Products, Collections, Orders group with dirty-only ordering UX", async () => {
  const [navigation, app, page, styles, headers] = await Promise.all([read("src/config/navigation.ts"), read("src/App.tsx"), read("src/pages/CommercePages.tsx"), read("src/styles/global.css"), read("public/_headers")]);
  assert.match(navigation, /path: "\/shop"[\s\S]{0,120}label: "Shop"/);
  for (const [path, label] of [["/products", "Products"], ["/collections", "Collections"], ["/orders", "Orders"]]) assert.match(navigation, new RegExp(`path: "${path.replaceAll("/", "\\/")}"[\\s\\S]{0,90}parentPath: "\\/shop"[\\s\\S]{0,100}label: "${label}"`));
  assert.equal((navigation.match(/path: "\/orders"/g) || []).length, 1);
  assert.match(app, /path="collections" element=\{<CommerceCollectionsPage/); assert.match(app, /path="shop" element=\{<Navigate to="\/products"/);
  assert.match(page, /featuredDirty && <div className="featured-order-save"/); assert.match(page, /Featured order changed/); assert.match(page, />Discard<\/button>/); assert.match(page, /Select all \{payload\.totalItems\} matching/); assert.match(page, /Rows per page/);
  for (const label of ["Create collection", "Stable Public slug", "Product assignments", "Archive collection", "Delete empty collection", "Assigned", "Public"]) assert.match(page, new RegExp(label));
  assert.match(styles, /\.featured-dirty-rail/); assert.match(styles, /\.collection-assignment__list/); assert.match(headers, /img-src[^;]*https:\/\/static\.wixstatic\.com/);
});
