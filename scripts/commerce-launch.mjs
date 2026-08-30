const baseUrl = String(process.env.COMMERCE_ADMIN_ORIGIN || "https://admin.thirdrailify.com").replace(/\/$/, "");
const command = process.argv[2] || "plan";
const execute = process.argv.includes("--execute");
const cookie = String(process.env.COMMERCE_ADMIN_SESSION_COOKIE || "");
const csrf = String(process.env.COMMERCE_ADMIN_CSRF_TOKEN || "");

if (!new Set(["plan", "donations-plan", "catalogue-apply", "activate", "donations-activate", "pause"]).has(command)) fail("Usage: npm run commerce:launch -- <plan|donations-plan|catalogue-apply|activate|donations-activate|pause> [--execute]");
if (!cookie) fail("COMMERCE_ADMIN_SESSION_COOKIE is required; this CLI never bypasses Admin authentication.");

const current = await request(command.startsWith("donations-") ? "/api/admin/commerce/launch?target=donations" : "/api/admin/commerce/launch");
if (command === "plan" || command === "donations-plan" || !execute) {
  const planOnly = command === "plan" || command === "donations-plan";
  process.stdout.write(`${JSON.stringify({ dryRun: !planOnly, requestedCommand: command, ...current }, null, 2)}\n`);
  if (!planOnly) process.stdout.write("No mutation was made. Add --execute with the protected CSRF environment value after reviewing this plan.\n");
  process.exit(current.ready ? 0 : 2);
}
if (!csrf) fail("COMMERCE_ADMIN_CSRF_TOKEN is required for an executed mutation.");

const body = command === "catalogue-apply"
  ? { confirmation: "APPLY ELIGIBLE SELLABILITY" }
  : command === "activate"
    ? { confirmation: "ACTIVATE LIVE COMMERCE", expectedRevision: current.revision }
    : command === "donations-activate"
      ? { confirmation: "ACTIVATE LIVE PAYPAL DONATIONS", expectedRevision: current.revision }
    : { confirmation: "PAUSE LIVE COMMERCE", expectedRevision: current.revision, reason: "Authorized operator CLI emergency pause." };
const path = command === "catalogue-apply" ? "/api/admin/commerce/launch/catalogue-apply" : command === "donations-activate" ? "/api/admin/commerce/launch/donations-activate" : `/api/admin/commerce/launch/${command}`;
const result = await request(path, { method: "POST", body: JSON.stringify(body) });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    redirect: "manual",
    headers: { Accept: "application/json", Cookie: cookie, ...(options.method === "POST" ? { "Content-Type": "application/json", "X-CSRF-Token": csrf } : {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) fail(payload?.message || `Admin launch endpoint returned HTTP ${response.status}.`);
  return payload;
}

function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
