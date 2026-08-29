export default {
  async scheduled(_controller, env, context) {
    context.waitUntil(triggerAdminOperations(env));
  },
};

async function triggerAdminOperations(env) {
  const timestamp = Date.now();
  const body = JSON.stringify({ timestamp });
  const secret = String(env?.COMMERCE_WORKER_SECRET || "");
  const url = String(env?.ADMIN_OPERATIONS_URL || "");
  if (secret.length < 32 || !url.startsWith("https://")) throw new Error("commerce worker trigger is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "X-Commerce-Worker-Signature": signature }, body });
  if (!response.ok) throw new Error(`commerce operations trigger returned ${response.status}`);
}
