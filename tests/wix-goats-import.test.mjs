import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicListings } from "../functions/_shared/goats-core.js";
import { applySqlBatches, commerceEnvironment, createCommerceDatabases } from "./commerce-test-helpers.mjs";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);
const script = new URL("../scripts/build-wix-goats-import.mjs", import.meta.url);
const sqlUrl = new URL("../output/goats-wix-import/import.sql", import.meta.url);
const manifestUrl = new URL("../output/goats-wix-import/manifest.json", import.meta.url);

test("Wix GOATS export builds a complete rerunnable private import and safe public projection", async () => {
  await run(process.execPath, [fileURLToPath(script)], { cwd: fileURLToPath(root) });
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.format, "thirdrailify-wix-goats-v1");
  assert.equal(manifest.submissions.length, 9);
  assert.equal(manifest.media.length, 19);
  assert.equal(new Set(manifest.submissions.map((item) => item.slug)).size, 9);
  assert.equal(manifest.submissions.every((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude)), true);

  const harness = await createCommerceDatabases();
  try {
    const sql = await readFile(sqlUrl, "utf8");
    await applySqlBatches(harness.commerceDb, sql);
    await applySqlBatches(harness.commerceDb, sql);
    const counts = await harness.commerceDb.prepare("SELECT COUNT(*) AS submissions, (SELECT COUNT(*) FROM community_media) AS media FROM community_submissions WHERE legacy_source = 'wix-wild-goats'").first();
    assert.deepEqual({ submissions: Number(counts.submissions), media: Number(counts.media) }, { submissions: 9, media: 19 });
    const projection = await publicListings(commerceEnvironment(harness), { pageSize: 48 });
    assert.equal(projection.total, 9);
    assert.equal(projection.items.some((item) => item.slug === "daniel-clancy"), true);
    assert.equal(projection.items.some((item) => item.slug === "darnell-quiggley"), true);
    assert.equal(JSON.stringify(projection).includes("Uploader Email"), false);
    assert.equal(JSON.stringify(projection).includes("ownerId"), false);
    assert.equal(JSON.stringify(projection).includes("hotmail.com"), false);
  } finally { await harness.dispose(); }
});
