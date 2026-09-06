import { loadEnvFile } from "node:process";
import { randomUUID, createHash } from "node:crypto";

if (!process.argv.includes("--execute-one-draft")) throw new Error("explicit_single_draft_authority_required");
loadEnvFile(".env");
const reference = `TR-WH-VERIFY-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
if (!/^[A-Za-z0-9_-]{1,32}$/.test(reference)) throw new Error("provider_external_reference_invalid_no_request_made");
const headers = { Authorization: `Bearer ${process.env.PRINTFUL_API_TOKEN}`, "X-PF-Store-Id": "18668025", "Content-Type": "application/json" };
const endpoint = "https://api.printful.com/v2/orders";
async function get(url) { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }); const p = await r.json().catch(() => ({})); return { status: r.status, data: p.data || p.result, paging: p.paging }; }
const before = await get(`${endpoint}?limit=1`);
if (before.status !== 200) throw new Error("provider_order_preflight_failed_no_draft_created");
console.log(JSON.stringify({ beforeProviderOrders: before.paging?.total ?? null, referenceFingerprint: createHash("sha256").update(reference).digest("hex") }));
let order;
try {
  // Empty item list is deliberate: the V2 draft contract allows incremental order building.
  // No charge or fulfillment can happen; this script has no confirmation request.
  const created = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ external_id: reference, recipient: { name: "Third Railify Webhook Test", address1: "100 Test Street", city: "Sydney", state_code: "NSW", country_code: "AU", zip: "2000" }, order_items: [] }), signal: AbortSignal.timeout(15_000) });
  const payload = await created.json().catch(() => ({})); order = payload.data || payload.result;
  if (!created.ok || !order?.id || order.status !== "draft") {
    const reason = String(payload.detail || payload.error?.message || (typeof payload.result === "string" ? payload.result : "provider_validation_failed")).replaceAll(String(process.env.PRINTFUL_API_TOKEN), "[redacted]").slice(0, 240);
    console.log(JSON.stringify({ createStatus: created.status, providerValidation: reason }));
    throw new Error(`controlled_draft_create_http_${created.status}`);
  }
  console.log(JSON.stringify({ providerDraftId: order.id, status: order.status, confirmed: false, charged: false }));
} finally {
  // External reference also permits cleanup after an ambiguous create response.
  const found = await get(`${endpoint}/@${reference}`);
  if (found.status === 200) {
    order = found.data;
    if (order.external_id !== reference || order.status !== "draft") throw new Error("cleanup_identity_or_state_mismatch_manual_review_required");
    const deleted = await fetch(`${endpoint}/${order.id}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
    const readback = await get(`${endpoint}/${order.id}`);
    console.log(JSON.stringify({ providerDraftId: order.id, deleteStatus: deleted.status, readbackStatus: readback.status, neverConfirmed: true }));
    if (deleted.status !== 204 || readback.status !== 404) throw new Error("controlled_draft_cleanup_unverified");
  } else if (found.status === 404) { console.log(JSON.stringify({ noDraftCreated: true, referenceLookupStatus: 404 })); } else if (found.status !== 404) throw new Error("controlled_draft_lookup_unavailable_cleanup_unverified");
}
const after = await get(`${endpoint}?limit=1`);
console.log(JSON.stringify({ afterProviderOrders: after.paging?.total ?? null }));
