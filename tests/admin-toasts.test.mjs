import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Admin transient feedback is rendered through one fixed global provider", async () => {
  const [provider, main, css] = await Promise.all([
    read("src/components/AdminToasts.tsx"),
    read("src/main.tsx"),
    read("src/styles/global.css"),
  ]);

  assert.match(main, /<AdminToastProvider>/);
  assert.match(provider, /createPortal\(/);
  assert.match(provider, /document\.body/);
  assert.match(provider, /role="status"/);
  assert.match(provider, /aria-live="polite"/);
  assert.match(provider, /event\.key === "Escape"/);
  assert.match(provider, /querySelector\('\[aria-modal="true"\]'\)/);
  assert.match(provider, /Dismiss notification/);
  assert.match(css, /\.admin-toast-region\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.admin-toast--success\s*\{[^}]*rgba\(114,\s*215,\s*165/s);
  assert.match(css, /\.admin-toast--info\s*\{[^}]*rgba\(187,\s*107,\s*217/s);
});

test("dashboard action feedback uses the shared popup instead of in-flow success banners", async () => {
  const pagePaths = [
    "src/pages/AccountsPage.tsx",
    "src/pages/BusinessInformationPage.tsx",
    "src/pages/CommercePages.tsx",
    "src/pages/CustomerEmailsPage.tsx",
    "src/pages/GoatsAdminPages.tsx",
    "src/pages/OperationsPages.tsx",
    "src/pages/SiteContentPage.tsx",
    "src/pages/TaxDocumentsPage.tsx",
    "src/pages/WheelsMechanicsPages.tsx",
  ];
  const sources = await Promise.all(pagePaths.map(read));
  for (const [index, source] of sources.entries()) {
    assert.match(source, /useAdminToast/, `${pagePaths[index]} must use the global toast authority`);
    assert.doesNotMatch(source, /className="auth-success"\s+role="status"/, `${pagePaths[index]} retains an in-flow auth success banner`);
    assert.doesNotMatch(source, /className="admin-success"\s+role="status"/, `${pagePaths[index]} retains an in-flow Admin success banner`);
    assert.doesNotMatch(source, /admin-alert admin-alert--success/, `${pagePaths[index]} retains an error-coloured success banner`);
  }
});
