import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("every genuine Admin semantic table is covered by the shared resizable primitive", async () => {
  const pages = new URL("../src/pages/", import.meta.url);
  const files = (await readdir(pages)).filter((name) => name.endsWith(".tsx"));
  const inventory = [];
  for (const name of files) {
    const source = await readFile(new URL(name, pages), "utf8");
    const count = source.match(/<table\b/g)?.length || 0;
    if (count) inventory.push([name, count]);
  }
  assert.deepEqual(inventory, [["AccountsPage.tsx", 1], ["CustomersPage.tsx", 1], ["WheelsAdminPages.tsx", 3]]);

  const [primitive, shell] = await Promise.all([
    readFile(new URL("../src/components/ResizableTables.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AdminShell.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /<ResizableTables\s*\/>/);
  assert.match(primitive, /querySelectorAll<HTMLTableElement>\("#admin-main table"\)/);
  assert.match(primitive, /pointerdown/); assert.match(primitive, /ArrowLeft/); assert.match(primitive, /ArrowRight/);
  assert.match(primitive, /thirdrailify\.admin\.table-widths\.v1/); assert.match(primitive, /Reset columns/);
});
