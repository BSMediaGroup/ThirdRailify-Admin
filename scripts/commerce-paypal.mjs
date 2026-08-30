import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  PAYPAL_WEBHOOK_EVENTS,
  PayPalApiError,
  getPayPalWebhook,
  listPayPalWebhooks,
  reconcilePayPalWebhook,
  validatePayPalOAuth,
} from "../functions/_shared/paypal-client.js";
import {
  exactEventSet,
  paypalWebhookUrl,
  safePayPalConfigurationEvidence,
} from "../functions/_shared/paypal-onboarding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WRANGLER = resolve(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const PROJECT = "thirdrailify-admin";
const DB = "THIRDRAILIFY_COMMERCE_DB";
const ENVIRONMENTS = new Set(["sandbox", "live"]);
const COMMANDS = new Set(["status", "configure", "verify"]);

export async function runCommercePayPal(argv = process.argv.slice(2), dependencies = {}) {
  const io = dependencies.io || defaultIo();
  const command = argv[0] || "status";
  const environment = argv[1] || null;
  if (!COMMANDS.has(command) || (command !== "status" && !ENVIRONMENTS.has(environment)) || (command === "status" && argv.length > 1) || (command !== "status" && argv.length !== 2)) {
    throw new Error("Usage: npm run commerce:paypal -- <status|configure sandbox|configure live|verify sandbox|verify live>. Credentials are never accepted as command-line arguments.");
  }
  const runtime = {
    env: dependencies.env || process.env,
    fetch: dependencies.fetch || fetch,
    wrangler: dependencies.wrangler || runWrangler,
    putSecret: dependencies.putSecret || putPagesSecret,
    deploy: dependencies.deploy || deployAdmin,
    promptSecret: dependencies.promptSecret || maskedPrompt,
    now: dependencies.now || (() => new Date()),
  };
  const origin = await adminOrigin(runtime.env, dependencies.readConfig || readFile);
  const webhookUrl = paypalWebhookUrl({ THIRDRAILIFY_ADMIN_ORIGIN: origin });
  if (command === "status") {
    const status = await loadStatus(runtime, webhookUrl);
    io.write(status);
    return status;
  }
  const credentials = await operatorCredentials(runtime, environment);
  const env = { [`PAYPAL_${environment.toUpperCase()}_CLIENT_ID`]: credentials.clientId, [`PAYPAL_${environment.toUpperCase()}_CLIENT_SECRET`]: credentials.clientSecret };
  const budget = providerCallBudget(environment, runtime.fetch);
  const oauth = await validatePayPalOAuth(env, environment, budget.fetch);
  if (command === "verify") {
    const verification = await verifyExistingWebhook(env, environment, webhookUrl, budget.fetch);
    const status = await loadStatus(runtime, webhookUrl);
    requireStoredConfiguration(status, environment);
    const result = { ok: true, command, environment, oauth: sanitizeOAuth(oauth), webhook: verification, configuration: status[environment], providerCalls: budget.counts() };
    io.write(result);
    return result;
  }

  const webhook = await reconcilePayPalWebhook(env, environment, webhookUrl, budget.fetch);
  const prefix = `PAYPAL_${environment.toUpperCase()}`;
  await runtime.putSecret(`${prefix}_CLIENT_ID`, credentials.clientId);
  await runtime.putSecret(`${prefix}_CLIENT_SECRET`, credentials.clientSecret);
  await runtime.putSecret(`${prefix}_WEBHOOK_ID`, webhook.webhookId);
  await runtime.deploy();
  const checkedAt = runtime.now().toISOString();
  const evidence = safePayPalConfigurationEvidence({ environment, oauth, webhookUrl, checkedAt });
  await persistEvidence(runtime.wrangler, environment, evidence, checkedAt);
  const status = await loadStatus(runtime, webhookUrl);
  requireStoredConfiguration(status, environment);
  const result = {
    ok: true,
    command,
    environment,
    oauth: sanitizeOAuth(oauth),
    webhook: { action: webhook.action, configured: true, readbackVerified: true, url: webhook.url, events: webhook.events },
    deployment: "admin_deployed",
    status,
    providerCalls: budget.counts(),
  };
  io.write(result);
  return result;
}

async function operatorCredentials(runtime, environment) {
  const prefix = `PAYPAL_${environment.toUpperCase()}`;
  const clientId = boundedCredential(runtime.env[`${prefix}_CLIENT_ID`] || await runtime.promptSecret(`${environment.toUpperCase()} Client ID: `), 512, "Client ID");
  const clientSecret = boundedCredential(runtime.env[`${prefix}_CLIENT_SECRET`] || await runtime.promptSecret(`${environment.toUpperCase()} Client Secret: `), 1024, "Client Secret");
  return { clientId, clientSecret };
}

async function verifyExistingWebhook(env, environment, url, fetchImpl) {
  const listed = await listPayPalWebhooks(env, environment, fetchImpl);
  const matches = (Array.isArray(listed.body?.webhooks) ? listed.body.webhooks : []).filter((item) => item?.url === url);
  if (matches.length !== 1 || !safeProviderId(matches[0]?.id)) throw new Error(matches.length > 1 ? "paypal_duplicate_webhooks" : "paypal_webhook_not_configured");
  const readback = await getPayPalWebhook(env, environment, matches[0].id, fetchImpl);
  const events = Array.isArray(readback.body?.event_types) ? readback.body.event_types.map((event) => event?.name) : [];
  if (readback.body?.url !== url || !exactEventSet(events)) throw new Error("paypal_webhook_readback_mismatch");
  return { configured: true, readbackVerified: true, url, events: [...PAYPAL_WEBHOOK_EVENTS] };
}

async function loadStatus(runtime, webhookUrl) {
  const names = [
    "PAYPAL_SANDBOX_CLIENT_ID", "PAYPAL_SANDBOX_CLIENT_SECRET", "PAYPAL_SANDBOX_WEBHOOK_ID",
    "PAYPAL_LIVE_CLIENT_ID", "PAYPAL_LIVE_CLIENT_SECRET", "PAYPAL_LIVE_WEBHOOK_ID",
  ];
  const inventory = await runtime.wrangler(["pages", "secret", "list", "--project-name", PROJECT]);
  const row = await remoteStatusRow(runtime.wrangler);
  const inventoryNames = namedSecretInventory(inventory.stdout);
  const binding = Object.fromEntries(names.map((name) => [name, {
    operatorEnvironment: String(runtime.env[name] || "").trim() ? "configured" : "absent",
    adminPages: inventoryNames.has(name) ? "configured" : "absent",
  }]));
  const metadata = parseJson(row.safe_metadata_json, {});
  return {
    ok: true,
    authority: "Admin Pages encrypted secrets + Commerce D1 safe evidence",
    webhookUrl,
    webhookEvents: [...PAYPAL_WEBHOOK_EVENTS],
    bindings: binding,
    sandbox: environmentStatus("sandbox", binding, metadata.sandbox, row),
    live: environmentStatus("live", binding, metadata.live, row),
    preferredProvider: parseJson(row.preferred_payment_provider, "paypal"),
    stripe: { configured: Number(row.stripe_configured || 0) === 1, enabled: parseJson(row.stripe_enabled, false), preferred: false },
    donationsEnabled: parseJson(row.paypal_donations_enabled, false),
    storeCheckoutEnabled: parseJson(row.paypal_store_checkout_enabled, false),
    liveCaptureEnabled: parseJson(row.paypal_live_capture_enabled, false),
    emergencyPaused: parseJson(row.commerce_emergency_paused, false),
    providerCalls: { oauth: 0, webhookListRead: 0, webhookCreate: 0, webhookPatch: 0, orders: 0, captures: 0 },
  };
}

function requireStoredConfiguration(status, environment) {
  const current = status?.[environment];
  if (current?.clientId !== "configured" || current?.clientSecret !== "configured" || current?.oauth !== "verified" || current?.webhook !== "configured") {
    throw new Error(`paypal_${environment}_stored_configuration_unverified`);
  }
}

function namedSecretInventory(value) {
  return new Set(String(value || "").match(/[A-Z][A-Z0-9_]{2,}/g) || []);
}

function environmentStatus(environment, binding, metadata = {}, row = {}) {
  const prefix = `PAYPAL_${environment.toUpperCase()}`;
  const storeCompleted = Number(row[`${environment}_store_completed`] || 0);
  const donationCompleted = Number(row[`${environment}_donation_completed`] || 0);
  return {
    clientId: binding[`${prefix}_CLIENT_ID`].adminPages,
    clientSecret: binding[`${prefix}_CLIENT_SECRET`].adminPages,
    oauth: metadata.oauth_verified === true ? "verified" : "unverified",
    webhook: binding[`${prefix}_WEBHOOK_ID`].adminPages === "configured" && metadata.webhook_readback_verified === true ? "configured" : "unconfigured",
    storeAcceptance: storeCompleted > 0 ? "passed" : "not_run",
    donationAcceptance: donationCompleted > 0 ? "passed" : "not_run",
  };
}

async function remoteStatusRow(wrangler) {
  const setting = (key) => `(SELECT value_json FROM commerce_settings WHERE setting_key='${key}')`;
  const sql = `SELECT p.safe_metadata_json,s.stripe_configured,
    ${setting("preferred_payment_provider")} preferred_payment_provider,
    ${setting("stripe_enabled")} stripe_enabled,
    ${setting("paypal_donations_enabled")} paypal_donations_enabled,
    ${setting("paypal_store_checkout_enabled")} paypal_store_checkout_enabled,
    ${setting("paypal_live_capture_enabled")} paypal_live_capture_enabled,
    ${setting("commerce_emergency_paused")} commerce_emergency_paused,
    (SELECT COUNT(*) FROM commerce_payment_attempts WHERE provider='paypal' AND environment='sandbox' AND commerce_order_id IS NOT NULL AND normalized_state='completed') sandbox_store_completed,
    (SELECT COUNT(*) FROM commerce_payment_attempts WHERE provider='paypal' AND environment='live' AND commerce_order_id IS NOT NULL AND normalized_state='completed') live_store_completed,
    (SELECT COUNT(*) FROM commerce_donations WHERE environment='sandbox' AND status='completed') sandbox_donation_completed,
    (SELECT COUNT(*) FROM commerce_donations WHERE environment='live' AND status='completed') live_donation_completed
    FROM commerce_provider_connections p CROSS JOIN commerce_payment_provider_state s WHERE p.provider='paypal' AND s.id='primary';`;
  const result = await wrangler(["d1", "execute", DB, "--remote", "--config", "wrangler.jsonc", "--command", sql, "--json"]);
  const parsed = parseJson(result.stdout, []);
  const row = parsed?.[0]?.results?.[0];
  if (!row) throw new Error("paypal_remote_status_unavailable");
  return row;
}

async function persistEvidence(wrangler, environment, evidence, checkedAt) {
  const safeJson = sqlString(JSON.stringify(evidence));
  const timestamp = sqlString(checkedAt);
  const configuredKey = `paypal_${environment}_configured`;
  const webhookKey = `paypal_${environment}_webhook_configured`;
  const column = environment === "live" ? "paypal_live_configured" : "paypal_sandbox_configured";
  const auditId = sqlString(`audit-paypal-config-${environment}-${checkedAt.replace(/[^0-9]/g, "").slice(0, 17)}`);
  const auditMetadata = sqlString(JSON.stringify({ environment, oauthVerified: true, oauthHttpStatus: evidence.oauth_http_status, webhookConfigured: true, webhookReadbackVerified: true, webhookUrl: evidence.webhook_url, events: evidence.webhook_events }));
  const sql = `INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at) VALUES
      ('${configuredKey}','true','safe',${timestamp}),('${webhookKey}','true','safe',${timestamp})
      ON CONFLICT(setting_key) DO UPDATE SET value_json='true',classification='safe',updated_at=excluded.updated_at;
    UPDATE commerce_payment_provider_state SET ${column}=1,revision=revision+1,transition_reason='PayPal ${environment.toUpperCase()} OAuth and webhook readback verified by secure operator CLI.',updated_by_actor='paypal-setup-cli',updated_at=${timestamp} WHERE id='primary';
    UPDATE commerce_provider_connections SET status=${environment === "live" ? "'connected'" : "status"},environment=${environment === "live" ? "'live'" : "environment"},safe_metadata_json=json_set(COALESCE(safe_metadata_json,'{}'),'$.${environment}',json(${safeJson})),last_synchronized_at=${timestamp},updated_at=${timestamp} WHERE provider='paypal';
    INSERT INTO commerce_audit(id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at) VALUES(${auditId},NULL,'commerce.paypal_provider_configured','commerce_provider_connections','paypal','success',${auditMetadata},${timestamp});`;
  const directory = await mkdtemp(resolve(tmpdir(), "thirdrailify-paypal-"));
  const file = resolve(directory, "evidence.sql");
  try {
    await writeFile(file, sql, { encoding: "utf8", mode: 0o600 });
    await wrangler(["d1", "execute", DB, "--remote", "--config", "wrangler.jsonc", "--file", file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function providerCallBudget(environment, fetchImpl) {
  const calls = { oauth: 0, webhookListRead: 0, webhookCreate: 0, webhookPatch: 0, orders: 0, captures: 0 };
  return {
    fetch: async (url, init = {}) => {
      const parsed = new URL(url);
      const method = String(init.method || "GET").toUpperCase();
      if (parsed.pathname === "/v1/oauth2/token") calls.oauth += 1;
      else if ((parsed.pathname === "/v1/notifications/webhooks" && method === "GET") || (/^\/v1\/notifications\/webhooks\/[^/]+$/.test(parsed.pathname) && method === "GET")) calls.webhookListRead += 1;
      else if (parsed.pathname === "/v1/notifications/webhooks" && method === "POST") calls.webhookCreate += 1;
      else if (/^\/v1\/notifications\/webhooks\/[^/]+$/.test(parsed.pathname) && method === "PATCH") calls.webhookPatch += 1;
      else if (parsed.pathname.includes("/v2/checkout/orders")) {
        if (parsed.pathname.endsWith("/capture")) calls.captures += 1;
        else calls.orders += 1;
      }
      if (calls.oauth > 2 || calls.webhookListRead > 3 || calls.webhookCreate > 1 || calls.webhookPatch > 1 || calls.orders > (environment === "live" ? 0 : 1) || calls.captures > (environment === "live" ? 0 : 1)) throw new Error("paypal_provider_call_budget_exceeded");
      return fetchImpl(url, init);
    },
    counts: () => ({ ...calls }),
  };
}

async function adminOrigin(env, readConfig) {
  if (String(env.THIRDRAILIFY_ADMIN_ORIGIN || "").trim()) return String(env.THIRDRAILIFY_ADMIN_ORIGIN).trim();
  const config = await readConfig(resolve(ROOT, "wrangler.jsonc"), "utf8");
  const match = config.match(/"THIRDRAILIFY_ADMIN_ORIGIN"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error("paypal_admin_origin_unavailable");
  return match[1];
}

async function runWrangler(args, options = {}) { return runNode([WRANGLER, ...args], options); }
async function putPagesSecret(name, value) {
  const result = await runWrangler(["pages", "secret", "put", name, "--project-name", PROJECT], { stdin: `${value}\n` });
  if (result.code !== 0) throw new Error(`paypal_secret_put_failed:${name}`);
}
async function deployAdmin() {
  await requireSuccess(runNode([resolve(ROOT, "node_modules", "typescript", "bin", "tsc"), "-b", "--pretty", "false"]), "paypal_admin_typecheck_failed");
  await requireSuccess(runNode([resolve(ROOT, "node_modules", "vite", "bin", "vite.js"), "build"]), "paypal_admin_build_failed");
  await requireSuccess(runWrangler(["pages", "deploy", "dist", "--project-name", PROJECT, "--branch", "main"]), "paypal_admin_deploy_failed");
}
function runNode(args, { stdin = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolvePromise({ code, stdout, stderr }) : reject(new Error(`operator_command_failed:${code}`)));
    if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
  });
}
async function requireSuccess(promise, code) { try { return await promise; } catch { throw new Error(code); } }

function maskedPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Named process environment credentials or an interactive terminal are required.");
  return new Promise((resolvePromise, reject) => {
    const input = process.stdin; const output = process.stdout; let value = "";
    output.write(label); input.setRawMode(true); input.resume(); input.setEncoding("utf8");
    const finish = (error) => { input.setRawMode(false); input.pause(); input.off("data", onData); output.write("\n"); error ? reject(error) : resolvePromise(value); };
    const onData = (character) => {
      if (character === "\u0003") return finish(new Error("paypal_setup_cancelled"));
      if (character === "\r" || character === "\n") return finish();
      if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); return; }
      if (character >= " " && character !== "\u007f" && value.length < 4096) value += character;
    };
    input.on("data", onData);
  });
}

function defaultIo() { return { write: (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }; }
function sanitizeOAuth(value) { return { environment: value.environment, configured: true, verified: true, httpStatus: value.httpStatus, debugId: value.debugId || null, tokenType: value.tokenType, expiresIn: value.expiresIn }; }
function boundedCredential(value, max, label) { const text = String(value || "").trim(); if (text.length < 8 || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`paypal_${label.toLowerCase().replaceAll(" ", "_")}_invalid`); return text; }
function safeProviderId(value) { return /^[A-Za-z0-9_-]{1,80}$/.test(String(value || "")); }
function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function parseJson(value, fallback) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runCommercePayPal().catch((error) => {
    const safe = error instanceof PayPalApiError
      ? { error: error.providerCode, operation: error.operation, httpStatus: error.httpStatus, debugId: error.debugId, message: error.providerReason, retryable: error.retryable }
      : { error: String(error?.message || "paypal_setup_failed").slice(0, 300) };
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  });
}
