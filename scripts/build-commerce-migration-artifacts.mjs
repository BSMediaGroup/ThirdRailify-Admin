import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { reconcileCatalogues } from "../functions/_shared/catalogue-reconciliation.js";

const liveDirectory = resolve("commerce-import/live");
const evidenceNames = [
  "printful-wix-source.snapshot.json",
  "printful-api-target.snapshot.json",
  "public-wix-catalog.snapshot.json",
  "catalogue-reconciliation.json",
];

const evidence = Object.fromEntries(await Promise.all(evidenceNames.map(async (name) => {
  const bytes = await readFile(resolve(liveDirectory, name));
  return [name, { bytes, json: JSON.parse(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }];
})));
const liveWixBytes = await readFile(resolve(liveDirectory, "live-wix-published.snapshot.json"));
const liveWix = JSON.parse(liveWixBytes);

validateEvidence(evidence, liveWix);

const source = evidence["printful-wix-source.snapshot.json"].json;
const target = evidence["printful-api-target.snapshot.json"].json;
const reconciliation = reconcileCatalogues({ source, target }, liveWix);
const generatedAt = new Date().toISOString();
const selection = {
  ...reconciliation.writeSelection,
  generatedAt,
  generatedFrom: {
    ...reconciliation.writeSelection.generatedFrom,
    liveWixSnapshotSha256: createHash("sha256").update(liveWixBytes).digest("hex"),
  },
};
const payloadPlan = {
  schemaVersion: 1,
  generatedAt,
  send: false,
  endpoint: "POST /store/products",
  counts: { products: reconciliation.plannedTargetPayloads.length, variants: reconciliation.plannedTargetPayloads.reduce((sum, payload) => sum + payload.sync_variants.length, 0) },
  payloads: reconciliation.plannedTargetPayloads,
};
const report = {
  schemaVersion: 1,
  generatedAt,
  immutableEvidenceSha256: Object.fromEntries(evidenceNames.map((name) => [name, evidence[name].sha256])),
  liveWixSnapshotSha256: createHash("sha256").update(liveWixBytes).digest("hex"),
  source: reconciliation.evidenceAggregates.source,
  target: reconciliation.evidenceAggregates.target,
  reconciliation: reconciliation.counts,
  selection: selection.counts,
  acceptanceGates: selection.acceptanceGates,
  duplicateEvidence: reconciliation.duplicateEvidence,
  targetDispositions: reconciliation.targetDispositions,
};
const corrected = { ...reconciliation, generatedAt, writeSelection: undefined };

await Promise.all([
  writeJson("catalogue-reconciliation.corrected.json", corrected),
  writeJson("catalogue-write-selection.json", selection),
  writeJson("printful-target-create-payloads.json", payloadPlan),
  writeJson("migration-evidence-report.json", report),
]);

console.log(JSON.stringify({ reconciliation: reconciliation.counts, selection: selection.counts, acceptanceGates: selection.acceptanceGates, payloads: payloadPlan.counts }, null, 2));

function validateEvidence(files, currentLiveWix) {
  const sourceSnapshot = files["printful-wix-source.snapshot.json"].json;
  const targetSnapshot = files["printful-api-target.snapshot.json"].json;
  const publicSnapshot = files["public-wix-catalog.snapshot.json"].json;
  const originalReconciliation = files["catalogue-reconciliation.json"].json;
  const failures = [
    sourceSnapshot.schemaVersion === 1 && String(sourceSnapshot.store?.id) === "16847493" && sourceSnapshot.store?.type === "wix" && sourceSnapshot.counts?.products === 119 && sourceSnapshot.counts?.variants === 2456 && sourceSnapshot.counts?.synced === 2293,
    targetSnapshot.schemaVersion === 1 && String(targetSnapshot.store?.id) === "18668025" && targetSnapshot.store?.type === "native" && targetSnapshot.counts?.products === 1 && targetSnapshot.counts?.variants === 1,
    publicSnapshot.schemaVersion === 1 && publicSnapshot.source?.productsRepresentedInCurrentPublicSnapshot === 8,
    originalReconciliation.schemaVersion === 1 && String(originalReconciliation.sourceStore?.id) === "16847493" && String(originalReconciliation.targetStore?.id) === "18668025",
    currentLiveWix.schemaVersion === 1 && currentLiveWix.counts?.publishedProducts === currentLiveWix.products?.length && currentLiveWix.products?.length > 0,
  ];
  if (failures.some((value) => !value)) throw new Error("Migration evidence identity validation failed.");
}

async function writeJson(name, value) {
  await writeFile(resolve(liveDirectory, name), `${JSON.stringify(value, (_key, item) => item === undefined ? undefined : item, 2)}\n`, "utf8");
}
