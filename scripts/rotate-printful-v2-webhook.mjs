import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { PRINTFUL_V2_WEBHOOK_EVENTS } from "../functions/_shared/printful-fulfillment.js";
import { PRINTFUL_WEBHOOK_URL, webhookResult } from "./configure-printful-v2-webhook.mjs";

// Rotation deliberately leaves event delivery disabled until Pages has the new key.
// No signing material is returned, logged, or written to a local file.
export async function rotatePrintfulWebhook({ token, fetchImpl = fetch, storeSecrets, deploy }) {
  if (!token || !storeSecrets || !deploy) throw new Error("rotation_dependencies_required");
  const headers = { Authorization: `Bearer ${token}`, "X-PF-Store-Id": "18668025", "Content-Type": "application/json" };
  const endpoint = "https://api.printful.com/v2/webhooks";
  async function provider(url, init = {}) {
    const response = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`webhook_provider_http_${response.status}`);
    return webhookResult(await response.json()) || {};
  }
  const before = await provider(`${endpoint}?show_expired=true`);
  if (before.default_url && before.default_url !== PRINTFUL_WEBHOOK_URL) throw new Error("unexpected_existing_webhook_url");
  const created = await provider(endpoint, { method: "POST", body: JSON.stringify({ default_url: PRINTFUL_WEBHOOK_URL, expires_at: null, events: [] }) });
  const publicKey = String(created.public_key || ""), secret = String(created.secret_key || "");
  if (!/^[A-Za-z0-9+/_=-]{4,512}$/.test(publicKey) || !/^(?:[a-fA-F0-9]{2}){32,512}$/.test(secret) || created.events?.length) throw new Error("rotation_signing_material_invalid_events_remain_disabled");
  await storeSecrets({ PRINTFUL_WEBHOOK_V2_PUBLIC_KEY: publicKey, PRINTFUL_WEBHOOK_V2_SECRET_HEX: secret });
  const deployment = await deploy();
  const raw = "{"; // Authenticated malformed JSON proves signature passed without recording fake evidence.
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(raw).digest("hex");
  const verified = await fetchImpl(PRINTFUL_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-pf-webhook-public-key": publicKey, "x-pf-webhook-signature": signature }, body: raw, signal: AbortSignal.timeout(15_000) });
  const result = await verified.json();
  if (verified.status !== 400 || result.error !== "printful_webhook_payload_invalid") throw new Error("deployed_verifier_failed_events_remain_disabled");
  for (const event of PRINTFUL_V2_WEBHOOK_EVENTS) await provider(`${endpoint}/${event}`, { method: "POST", body: "{}" });
  const after = await provider(`${endpoint}?show_expired=true`);
  if (after.public_key !== publicKey || after.default_url !== PRINTFUL_WEBHOOK_URL || after.expires_at || (after.events || []).map(e => e.type).sort().join() !== [...PRINTFUL_V2_WEBHOOK_EVENTS].sort().join() || after.events.some(e => e.url && e.url !== PRINTFUL_WEBHOOK_URL)) throw new Error("rotation_final_readback_mismatch");
  return { configured: true, readbackVerified: true, secretBinding: "PRINTFUL_WEBHOOK_V2_SECRET_HEX", secretsStored: true, verifier: "passed", fingerprint: createHash("sha256").update(publicKey).digest("hex"), events: [...PRINTFUL_V2_WEBHOOK_EVENTS], deployment };
}
async function main() {
  if (!process.argv.includes("--execute-rotation")) throw new Error("explicit_rotation_flag_required");
  loadEnvFile(".env");
  const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
  const result = await rotatePrintfulWebhook({ token: process.env.PRINTFUL_API_TOKEN,
    storeSecrets: async values => {
      const r = spawnSync(process.execPath, [wrangler, "pages", "secret", "bulk", "--project-name", "thirdrailify-admin"], { input: JSON.stringify(values), encoding: "utf8", timeout: 60_000 });
      if (r.status !== 0) throw new Error("encrypted_secret_write_failed_events_disabled");
      console.log("Encrypted signing bindings stored; event delivery remains disabled.");
    },
    deploy: async () => {
      const r = spawnSync(process.execPath, [wrangler, "pages", "deploy", "dist", "--project-name", "thirdrailify-admin", "--branch", "main", "--commit-dirty=true"], { encoding: "utf8", timeout: 240_000 });
      if (r.status !== 0) throw new Error("pages_deploy_failed_events_disabled");
      const url = r.stdout.match(/https:\/\/([a-f0-9]+)\.thirdrailify-admin\.pages\.dev/);
      if (!url) throw new Error("deployment_identity_unavailable_events_disabled");
      console.log(`Receiver deployed: ${url[0]}`);
      return url[1];
    },
  });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Printful rotation did not complete. Inspect safe provider configuration before resuming; do not create an order."); process.exitCode = 1; });
