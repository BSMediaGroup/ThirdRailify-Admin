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
