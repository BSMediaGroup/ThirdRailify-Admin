import { loadEnvFile } from "node:process";

try { loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* Cloudflare-only credentials are valid. */ }

const token = String(process.env.PRINTFUL_API_TOKEN || "");
const storeId = String(process.env.PRINTFUL_STORE_ID || "18668025");
if (!token) throw new Error("PRINTFUL_API_TOKEN is not available for read-only webhook audit.");
if (!/^\d{6,20}$/.test(storeId)) throw new Error("PRINTFUL_STORE_ID is invalid.");

const response = await fetch("https://api.printful.com/v2/webhooks?show_expired=true", {
  method: "GET",
  headers: { Authorization: `Bearer ${token}`, "X-PF-Store-Id": storeId, Accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});
const payload = await response.json().catch(() => null);
if (!response.ok) throw new Error(`Printful webhook audit failed with HTTP ${response.status}.`);
const result = payload?.result && typeof payload.result === "object" ? payload.result : {};
const events = Array.isArray(result.events) ? result.events.map((event) => ({ type: String(event?.type || ""), usesDefaultUrl: !event?.url })).filter((event) => event.type).sort((a, b) => a.type.localeCompare(b.type)) : [];
console.log(JSON.stringify({
  ok: true,
  storeId,
  defaultUrl: typeof result.default_url === "string" ? result.default_url : null,
  expiresAt: result.expires_at || null,
  events,
  signingKeysReturned: Boolean(result.public_key || result.secret_key),
}, null, 2));
