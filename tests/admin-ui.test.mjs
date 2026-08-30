import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("Admin controls share one tokenized semantic button system", async () => {
  const styles = await read("src/styles/global.css");
  for (const token of ["--control-height", "--control-compact-height", "--control-icon-size", "--control-padding-inline", "--control-gap", "--control-radius", "--control-transition", "--control-disabled-opacity", "--control-focus-ring"]) assert.match(styles, new RegExp(token));
  for (const variant of ["primary-button", "secondary-button", "ghost-button", "danger-button", "danger-outline-button", "text-button", "compact-button", "icon-button"]) assert.match(styles, new RegExp(`\\.${variant}`));
  assert.match(styles, /button \{[^}]*min-height: var\(--control-height\);[^}]*appearance: none;[^}]*var\(--control-padding-inline\)[^}]*linear-gradient/);
  assert.match(styles, /button:focus-visible \{[^}]*var\(--control-focus-ring\)/);
  assert.match(styles, /input\[type="file"\]::file-selector-button/);
});

test("Admin sidebar keeps branding outside the independently scrollable navigation region", async () => {
  const [shell, styles] = await Promise.all([
    read("src/components/AdminShell.tsx"),
    read("src/styles/global.css"),
  ]);
  assert.match(shell, /className="sidebar-brand-panel"[\s\S]*className="brand-lockup"/);
  assert.match(shell, /className="sidebar-scroll-region"[\s\S]*className="primary-nav"[\s\S]*className="sidebar-footer"/);
  assert.match(shell, /className="sidebar-footer"[\s\S]*name="shield"[\s\S]*Authenticated control plane[\s\S]*D1 account authority/);
  assert.doesNotMatch(shell, /className="environment-note"|className="status-dot"/);
  assert.match(styles, /\.sidebar \{[\s\S]*overflow: hidden;/);
  assert.match(styles, /\.sidebar-brand-panel \{[^}]*flex: 0 0 auto;[^}]*border-bottom:/);
  assert.match(styles, /\.admin-layout--collapsed \.sidebar-brand-panel \{ justify-content: center; \}/);
  assert.match(styles, /\.sidebar-scroll-region \{[^}]*min-height: 0;[^}]*flex: 1 1 auto;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/);
});

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

test("commerce email cards stay left-aligned and email/document previews consume canonical server HTML", async () => {
  const [emailPage, taxPage, styles, taxStyles, core, brand] = await Promise.all([
    read("src/pages/CustomerEmailsPage.tsx"), read("src/pages/TaxDocumentsPage.tsx"), read("src/styles/global.css"), read("src/styles/tax-documents.css"), read("functions/_shared/commerce-control-plane.js"), read("functions/_shared/thirdrail-brand.js"),
  ]);
  assert.match(styles, /\.customer-email-workspace > nav button \{[^}]*align-items: start;[^}]*text-align: left;/);
  assert.match(styles, /\.customer-email-workspace > nav strong \{[^}]*text-align: left;/);
  assert.match(styles, /\.customer-email-workspace > nav small \{[^}]*text-align: left;/);
  assert.match(emailPage, /srcDoc=\{preview\.preview\.html\}/); assert.match(emailPage, /canonical sample preview/);
  assert.match(taxPage, /srcDoc=\{preview\.preview\.html\}/); assert.match(taxPage, /canonical SAMPLE \/ TEST preview/);
  assert.match(taxStyles, /\.document-preview-panel > iframe/);
  assert.match(core, /template\.templateKind === "document"[\s\S]*renderCommerceDocument[\s\S]*renderCommerceEmail/);
  assert.match(core, /html: output\.html, text: output\.text/);
  assert.match(brand, /trzapcolorcon\.svg/); for (const font of ["American Captain", "Blinker", "Geist Mono"]) assert.match(brand, new RegExp(font));
});

test("GOATS approved records expose durable content, media, and reaction reset controls", async () => {
  const [app, page, client, navigation] = await Promise.all([read("src/App.tsx"), read("src/pages/GoatsAdminPages.tsx"), read("src/goats/client.ts"), read("src/config/navigation.ts")]);
  assert.match(app, /path="goats\/reactions" element={guard\("\/goats", <Navigate to="\/goats\/approved" replace/);
  assert.match(app, /path="goats\/settings"/);
  for (const label of ["Approved listings remain editable", "Add, replace, or remove images", "Reset all reactions", "Save global defaults"]) assert.match(page, new RegExp(label));
  assert.match(page, /media\.some\(\(media\) => media\.role === "profile"\)[\s\S]*Add profile/);
  assert.match(page, /media\.role === "profile" \? "image\/jpeg,image\/png,image\/webp,image\/gif"/);
  assert.match(client, /uploadGoatMedia/); assert.match(client, /deleteGoatMedia/); assert.match(client, /saveGoatSettings/); assert.match(client, /resetGoatReactions/);
  assert.doesNotMatch(navigation, /path: "\/goats\/reactions"/); assert.match(navigation, /path: "\/goats\/settings"/);
});

test("Admin inbox is linked from navigation, shell indicators, overview, and account menu", async () => {
  const [app, navigation, shell, account, overview, inbox, styles] = await Promise.all([read("src/App.tsx"), read("src/config/navigation.ts"), read("src/components/AdminShell.tsx"), read("src/auth/AdminAccountWidget.tsx"), read("src/pages/OverviewPage.tsx"), read("src/pages/InboxPage.tsx"), read("src/styles/global.css")]);
  assert.match(app, /path="inbox" element={guard\("\/inbox", <InboxPage/);
  assert.match(navigation, /path: "\/inbox"[\s\S]{0,100}label: "Admin Inbox"/);
  assert.match(shell, /actionable\.goats\.submissions/); assert.match(shell, /nav-badge/);
  assert.match(account, /Admin Inbox/); assert.match(account, /admin-account__badge/);
  assert.match(styles, /\.admin-account__actions button \{[^}]*justify-content: flex-start/);
  assert.match(overview, /Latest notices/); assert.match(overview, /Open full inbox/);
  assert.match(inbox, /Mark all read/); assert.match(inbox, /Unread only/);
});

test("Admin account exits preserve identity and the refusal screen links to Public", async () => {
  const [account, boundary, provider] = await Promise.all([
    read("src/auth/AdminAccountWidget.tsx"),
    read("src/auth/AdminAccessBoundary.tsx"),
    read("src/auth/AuthProvider.tsx"),
  ]);
  assert.match(account, /Open public site/);
  assert.match(account, /openPublicSite/);
  assert.match(account, /target="_blank"/);
  assert.match(account, /rel="noopener noreferrer"/);
  assert.match(account, /openPublicSite\("\/", true\)/);
  assert.match(boundary, /Go to Third Railify/);
  assert.match(boundary, /Admin access required/);
  assert.match(boundary, /openPublicSite/);
  assert.match(provider, /createSiteTransfer/);
  assert.match(provider, /window\.open\("about:blank", "_blank"\)/);
});

test("Admin operational routes replace scaffolds and keep access visuals presentation-only", async () => {
  const [app, operations, access, badge, styles] = await Promise.all([
    read("src/App.tsx"), read("src/pages/OperationsPages.tsx"), read("src/pages/AccountsPage.tsx"), read("src/components/AccountAccessBadge.tsx"), read("src/styles/global.css"),
  ]);
  for (const [path, page] of [["media", "MediaOperationsPage"], ["membership", "MembershipOperationsPage"], ["integrations", "IntegrationsOperationsPage"], ["settings", "SettingsOperationsPage"]]) assert.match(app, new RegExp(`path="${path}" element=\\{guard\\("/${path}", <${page}`));
  for (const label of ["Media library", "Accounts, not subscribers", "Provider directory", "Configuration directory", "Not yet configurable"]) assert.match(operations, new RegExp(label));
  assert.match(operations, /Promise\.allSettled/);
  assert.match(operations, /no R2 object key is exposed/);
  assert.match(operations, /performs no provider verification call/);
  assert.match(operations, /select disabled/);
  assert.match(access, /<AccountRoleChip account=\{account\}/);
  assert.match(badge, /master_admin[\s\S]*full_admin[\s\S]*regular_user/);
  assert.match(badge, /role === "admin" && account\.adminLevel === "master"/);
  assert.doesNotMatch(badge, /isAdmin|isMasterAdmin|throw new AuthFailure/);
  for (const selector of ["account-role-chip--master_admin", "account-role-chip--full_admin", "account-role-chip--regular_user"]) assert.match(styles, new RegExp(`\\.${selector}`));
});

test("Admin account identity uses suffix badges without an obsolete status dot or third identity row", async () => {
  const [widget, badge] = await Promise.all([read("src/auth/AdminAccountWidget.tsx"), read("src/components/AccountAccessBadge.tsx")]);
  assert.match(widget, /account-identity-name[\s\S]*<AccountAccessBadge account=\{account\}/);
  assert.doesNotMatch(widget, /admin-account__identity[\s\S]{0,260}<small>\{accessLabel\}<\/small>/);
  assert.doesNotMatch(widget, /status-dot|online-dot|presence-dot/);
  assert.match(badge, /aria-label=\{label\}/);
  assert.match(badge, /title=\{label\}/);
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
  assert.match(app, /path="content" element={guard\("\/content", <SiteContentPage/);
  for (const label of ["Normal promo / info", "Homepage content rail", "Seamless marquee scroll", "Third Railify triple zap", "Divider size", "Ticker divider icon", "Ticker divider size", "Allow visitors to dismiss", "Automatic Live Now", "Presentation mode", "Animation speed", "Locked destination", "Fixture preview only", "Unsaved changes"]) assert.match(page, new RegExp(label));
  assert.match(page, /SAMPLE PREVIEW — Third Railify live broadcast title/);
  assert.match(page, /<code>\/watch\/live<\/code>/);
  assert.doesNotMatch(page, /Active stream title<\/span><input/);
  assert.match(client, /expectedRevision/);
  assert.match(client, /X-CSRF-Token/);
});

test("Overview is a fail-soft operational snapshot rather than a deferred foundation page", async () => {
  const [page, styles, navigation, scripts] = await Promise.all([read("src/pages/OverviewPage.tsx"), read("src/styles/global.css"), read("src/config/navigation.ts"), read("package.json")]);
  for (const authority of ["/api/admin/status", "getAnalytics", "getCommerceOverview", "manageWatch", "getGoatsOverview", "readBannerSettings"]) assert.match(page, new RegExp(authority.replaceAll("/", "\\/")));
  for (const label of ["Analytics snapshot", "Audience trend", "Page views", "Anonymous sessions", "Mapped regions", "Operational workspaces", "Runtime posture", "Operational priorities", "Recent GOATS", "Partial operational snapshot"]) assert.match(page, new RegExp(label));
  assert.match(page, /Missing values remain unavailable rather than being replaced with zero/);
  assert.match(page, /restricted for this role/);
  assert.match(page, /overview-pulse__credential/);
  assert.match(page, /Account level \/ server verified/);
  assert.match(page, /access\.isMasterAdmin \? "Master" : "Full Admin"/);
  assert.match(page, /access\.isMasterAdmin \? <AccountAccessIcon kind="master_admin" \/> : <AdminIcon name="shield" size=\{28\} \/>/);
  assert.doesNotMatch(page, /Authenticated foundation|Still intentionally deferred|Products and orders remain provider-neutral shells/);
  assert.match(styles, /\.overview-module-grid/);
  assert.match(styles, /\.overview-analytics__panel/);
  assert.match(styles, /\.overview-analytics__line\.is-views/);
  assert.match(styles, /\.overview-pulse__shield::before/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.overview-hero::after/);
  assert.match(navigation, /summary: "Cross-system operational state, queues, and direct workspace routes\."/);
  assert.match(scripts, /"test:browser:overview"/);
});

test("Orders is a read-only paginated management surface with isolated TEST evidence and no provider controls", async () => {
  const [page, client, core, route, shell] = await Promise.all([read("src/pages/OrdersManagementPage.tsx"), read("src/commerce/client.ts"), read("functions/_shared/checkout-core.js"), read("functions/api/admin/commerce/[[path]].js"), read("src/components/AdminShell.tsx")]);
  for (const label of ["Server-backed order history", "Live gross paid value", "TEST-only order history", "Financial breakdown", "Customer communication", "Persisted chronological evidence", "Provider actions unavailable"]) assert.match(page, new RegExp(label));
  for (const forbidden of ["Generate Test Checkout", "Open Stripe TEST Checkout", "Refund payment", "Submit fulfillment", "Resend email"]) assert.doesNotMatch(page, new RegExp(forbidden));
  assert.match(client, /getCommerceOrder\(orderId/); assert.match(client, /pageSize\?: 20 \| 50 \| 75 \| 100/);
  assert.match(route, /commerceOrderDetailPayload/); assert.match(route, /requireCommerceCapability\(env, session, "commerce\.view"\)/);
  assert.match(core, /normalizeOrderListOptions/); assert.match(core, /live_gross_amount/); assert.match(core, /environment = 'live'/); assert.match(core, /submissionEnabled: false/);
  assert.match(shell, /area\.path\.toLowerCase\(\) === location\.pathname\.toLowerCase\(\)/); assert.match(shell, /navigate\(`\$\{canonical\}/);
});

test("Fulfillment & Shipping uses the dedicated read-only control plane and exposes no provider or migration action", async () => {
  const [app, navigation, page, client, route] = await Promise.all([read("src/App.tsx"), read("src/config/navigation.ts"), read("src/pages/FulfillmentShippingPage.tsx"), read("src/commerce/client.ts"), read("functions/api/admin/commerce/[[path]].js")]);
  assert.match(app, /path="commerce\/fulfillment" element=\{guard\("\/commerce\/fulfillment", <FulfillmentShippingPage/);
  assert.match(navigation, /path: "\/commerce\/fulfillment"[\s\S]{0,100}label: "Fulfillment & Shipping"/);
  for (const label of ["Server-derived readiness", "Order fulfillment pipeline", "Product & variant mapping health", "Draft order preview", "Recent fulfillment evidence", "Advanced / technical"]) assert.match(page, new RegExp(label));
  for (const forbidden of ["executePermanentPrintfulMigration", "getPermanentPrintfulMigration", "CONTINUE PERMANENT PRINTFUL", "RESUME PERMANENT PRINTFUL", "Fulfill Now", "Create Printful Order"]) assert.doesNotMatch(page, new RegExp(forbidden));
  assert.match(client, /getFulfillmentShipping\(\).*\/api\/admin\/commerce\/fulfillment/);
  assert.match(route, /path === "fulfillment"[\s\S]{0,180}requireCommerceCapability\(env, session, "commerce\.view"\)[\s\S]{0,180}fulfillmentShippingPayload/);
});

test("Shop is an expandable Products, Collections, Orders group with dirty-only ordering UX", async () => {
  const [navigation, app, page, styles, headers] = await Promise.all([read("src/config/navigation.ts"), read("src/App.tsx"), read("src/pages/CommercePages.tsx"), read("src/styles/global.css"), read("public/_headers")]);
  assert.match(navigation, /path: "\/shop"[\s\S]{0,120}label: "Shop"/);
  for (const [path, label] of [["/products", "Products"], ["/collections", "Collections"], ["/orders", "Orders"]]) assert.match(navigation, new RegExp(`path: "${path.replaceAll("/", "\\/")}"[\\s\\S]{0,90}parentPath: "\\/shop"[\\s\\S]{0,100}label: "${label}"`));
  assert.equal((navigation.match(/path: "\/orders"/g) || []).length, 1);
  assert.match(app, /path="collections" element=\{guard\("\/collections", <CommerceCollectionsPage/); assert.match(app, /path="shop" element=\{guard\("\/shop", <Navigate to="\/products"/);
  assert.match(page, /featuredDirty && <div className="featured-order-save"/); assert.match(page, /Featured order changed/); assert.match(page, />Discard<\/button>/); assert.match(page, /Select all \{payload\.totalItems\} matching/); assert.match(page, /Rows per page/);
  for (const label of ["Create collection", "Stable Public slug", "Product membership", "Current products", "Add products", "Show collection on storefront", "Archive collection", "Delete empty collection", "Rows per page", "Edit collection"]) assert.match(page, new RegExp(label));
  assert.match(page, /getCollectionList/); assert.match(page, /bulkUpdateCollections/); assert.match(page, /updateCollectionMemberships/); assert.match(page, /No standalone collection image field exists/);
  assert.match(styles, /\.featured-dirty-rail/); assert.match(styles, /\.collection-membership-grid/); assert.match(styles, /\.collection-admin-list > article/); assert.match(headers, /img-src[^;]*https:\/\/static\.wixstatic\.com/); assert.match(headers, /img-src[^;]*https:\/\/thirdrailify\.pages\.dev/);
});

test("Analytics and inbox surfaces expose truthful states, bulk controls, and accessible details", async () => {
  const [app, navigation, analytics, inbox, inboxClient, styles] = await Promise.all([
    read("src/App.tsx"), read("src/config/navigation.ts"), read("src/pages/AnalyticsPage.tsx"),
    read("src/pages/InboxPage.tsx"), read("src/inbox/client.ts"), read("src/styles/global.css"),
  ]);
  assert.match(app, /path="analytics" element=\{guard\("\/analytics", <AnalyticsPage/);
  assert.match(navigation, /path: "\/analytics"[\s\S]{0,120}Audience Analytics/);
  for (const text of ["Audience activity map", "Traffic comparison matrix", "Collected, not profit", "Preceding period unavailable", "No events retained yet"]) assert.match(analytics, new RegExp(text));
  assert.match(analytics, /import \* as maplibregl from "maplibre-gl"/); assert.match(analytics, /setWorkerUrl\(maplibreWorkerUrl\)/); assert.match(analytics, /data-analytics-map-engine="maplibre"/); assert.match(analytics, /Fullscreen audience activity map/); assert.match(analytics, /role="img"[\s\S]{0,80}aria-label="World map/);
  assert.match(analytics, /CountryFlag countryCode=\{point\.countryCode\}/); assert.match(analytics, /createCountryFlagElement\(point\.countryCode\)/); assert.match(analytics, /resetResizableTable\("analytics-comparison"\)/);
  assert.match(analytics, /analytics-trend__line is-views/); assert.match(styles, /analytics-line-draw/);
  assert.match(inbox, /role="dialog"/); assert.match(inbox, /Mark unread/); assert.match(inbox, /inbox-message__actions/); assert.match(inbox, /Delete/);
  assert.match(inboxClient, /mutateInboxMessages/); assert.match(inboxClient, /"read" \| "unread" \| "delete"/);
  assert.match(styles, /\.message-lightbox/); assert.match(styles, /\.analytics-map-panel/); assert.match(styles, /prefers-reduced-motion/);
});
