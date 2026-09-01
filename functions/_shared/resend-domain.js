import { AuthFailure, cleanText, nowIso, randomId } from "./auth-core.js";
import { requireCommerceDb, validateTemplate, writeCommerceAudit } from "./commerce-core.js";

export const RESEND_SENDING_DOMAIN = "notify.thirdrailify.com";
const RESEND_API_ORIGIN = "https://api.resend.com";
const REQUEST_SETTING = "resend_domain_reconcile_requested";
const ALLOWED_RECORD_TYPES = new Set(["MX", "TXT", "CNAME"]);

export async function reconcileRequestedResendDomain(env, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const request = await db.prepare("SELECT value_json FROM commerce_settings WHERE setting_key=?").bind(REQUEST_SETTING).first();
  if (json(request?.value_json, false) !== true) return { requested: false };
  const claimed = await db.prepare("UPDATE commerce_settings SET value_json='\"processing\"',updated_at=? WHERE setting_key=? AND value_json='true'")
    .bind(nowIso(), REQUEST_SETTING).run();
  if (Number(claimed?.meta?.changes || 0) !== 1) return { requested: false };
  try {
    const evidence = await reconcileResendDomain(env, fetchImpl);
    await persistEvidence(env, evidence);
    return { requested: true, ...publicEvidence(evidence) };
  } catch (error) {
    await persistFailure(env, error);
    return { requested: true, status: "error", error: "resend_domain_reconciliation_failed" };
  } finally {
    await db.prepare("UPDATE commerce_settings SET value_json='false',updated_at=? WHERE setting_key=?").bind(nowIso(), REQUEST_SETTING).run();
  }
}

export async function reconcileResendDomain(env, fetchImpl = fetch) {
  const apiKey = String(env?.RESEND_API_KEY || "").trim();
  if (apiKey.length < 16) throw new AuthFailure(503, "resend_credential_unavailable", "The Resend production credential is unavailable.");
  requireCanonicalSender(env?.MAIL_FROM);
  const listed = await resendRequest(fetchImpl, apiKey, "/domains");
  const domains = Array.isArray(listed?.data) ? listed.data : [];
  const matches = domains.filter((entry) => cleanText(entry?.name, 253).toLowerCase() === RESEND_SENDING_DOMAIN);
  if (matches.length > 1) throw new AuthFailure(409, "resend_domain_duplicate", "Multiple Resend domain records match the canonical sending domain.");
  let domain = matches[0] || null;
  let created = false;
  if (!domain) {
    domain = await resendRequest(fetchImpl, apiKey, "/domains", {
      method: "POST",
      body: JSON.stringify({ name: RESEND_SENDING_DOMAIN, capabilities: { sending: "enabled", receiving: "disabled" } }),
    });
    created = true;
  }
  const domainId = providerId(domain?.id);
  await resendRequest(fetchImpl, apiKey, `/domains/${encodeURIComponent(domainId)}/verify`, { method: "POST" });
  const current = await resendRequest(fetchImpl, apiKey, `/domains/${encodeURIComponent(domainId)}`);
  if (cleanText(current?.name, 253).toLowerCase() !== RESEND_SENDING_DOMAIN) throw new AuthFailure(502, "resend_domain_mismatch", "Resend returned a different sending domain.");
  const capabilities = current?.capabilities && typeof current.capabilities === "object" ? current.capabilities : {};
  if (capabilities.sending !== "enabled" || capabilities.receiving === "enabled") throw new AuthFailure(409, "resend_domain_capability_invalid", "The Resend domain capabilities do not match the sending-only contract.");
  return {
    id: domainId,
    name: RESEND_SENDING_DOMAIN,
    status: domainStatus(current?.status),
    region: cleanText(current?.region, 40) || null,
    created,
    checkedAt: nowIso(),
    records: normalizeRecords(current?.records),
  };
}

async function persistEvidence(env, evidence) {
  const db = requireCommerceDb(env);
  const verified = evidence.status === "verified";
  const timestamp = evidence.checkedAt;
  const statements = [
    setting(db, "resend_domain_id", evidence.id, timestamp),
    setting(db, "resend_domain_status", evidence.status, timestamp),
    setting(db, "resend_domain_dns_records", evidence.records, timestamp),
    setting(db, "resend_domain_checked_at", timestamp, timestamp),
    setting(db, "resend_domain_verified", verified, timestamp),
  ];
  if (verified) {
    const row = await db.prepare("SELECT * FROM commerce_templates WHERE template_key='order_confirmation'").first();
    validateTemplate({
      templateKey: row?.template_key,
      templateKind: row?.template_kind,
      displayName: row?.display_name,
      subject: row?.subject,
      preheader: row?.preheader,
      heading: row?.heading,
      introduction: row?.introduction,
      bodyBlocks: json(row?.body_blocks_json, []),
      ctaLabel: row?.cta_label,
      ctaUrl: row?.cta_url,
      supportText: row?.support_text,
      footer: row?.footer,
      accentColor: row?.accent_color,
      status: "ready",
      enabled: true,
      revision: Number(row?.revision || 0),
    });
    statements.push(db.prepare("UPDATE commerce_templates SET status='ready',enabled=1,revision=revision+1,updated_at=?,updated_by_account_id='commerce-operations-worker' WHERE template_key='order_confirmation' AND (status<>'ready' OR enabled<>1)").bind(timestamp));
  }
  await db.batch(statements);
  await writeCommerceAudit(env, {
    actorAccountId: "commerce-operations-worker",
    action: "commerce.resend_domain_reconciled",
    targetType: "resend_domain",
    targetId: evidence.id,
    result: "success",
    metadata: { domain: evidence.name, status: evidence.status, created: evidence.created, checkedAt: evidence.checkedAt, records: evidence.records.map(({ type, name, status }) => ({ type, name, status })) },
  });
}

async function persistFailure(env, error) {
  const db = requireCommerceDb(env);
  const timestamp = nowIso();
  const status = Number(error?.status);
  await db.batch([
    setting(db, "resend_domain_status", "error", timestamp),
    setting(db, "resend_domain_verified", false, timestamp),
    setting(db, "resend_domain_checked_at", timestamp, timestamp),
    db.prepare("INSERT INTO commerce_provider_diagnostics(id,provider,operation_kind,http_status,provider_code,provider_reason,retryable,occurred_at) VALUES (?,'resend','domain_reconcile',?,?,?,?,?)")
      .bind(`cpd_${randomId()}`, Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, cleanText(error?.code, 100) || "provider_error", cleanText(error?.message, 300) || "Resend domain reconciliation failed.", status >= 500 ? 1 : 0, timestamp),
  ]);
}

async function resendRequest(fetchImpl, apiKey, path, init = {}) {
  const response = await fetchImpl(`${RESEND_API_ORIGIN}${path}`, {
    ...init,
    redirect: "manual",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "ThirdRailify-Commerce/1.0", ...(init.headers || {}) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    const failure = new AuthFailure(response.status >= 500 ? 502 : 409, cleanText(payload?.name, 100) || "resend_domain_provider_error", cleanText(payload?.message, 300) || `Resend domain request returned HTTP ${response.status}.`);
    failure.status = response.status;
    throw failure;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AuthFailure(502, "resend_domain_response_invalid", "Resend returned an invalid domain response.");
  return payload;
}

function normalizeRecords(value) {
  if (!Array.isArray(value) || !value.length) throw new AuthFailure(502, "resend_domain_records_missing", "Resend did not return the required DNS records.");
  return value.map((record) => {
    const type = cleanText(record?.type, 10).toUpperCase();
    if (!ALLOWED_RECORD_TYPES.has(type)) throw new AuthFailure(502, "resend_domain_record_type_invalid", "Resend returned an unsupported DNS record type.");
    const name = recordName(record?.name);
    const result = {
      record: cleanText(record?.record, 40) || null,
      type,
      name,
      value: cleanText(record?.value, 4096),
      status: domainStatus(record?.status),
      priority: type === "MX" ? Number(record?.priority || 10) : null,
    };
    if (!result.value || (type === "MX" && (!Number.isSafeInteger(result.priority) || result.priority < 0 || result.priority > 65535))) throw new AuthFailure(502, "resend_domain_record_invalid", "Resend returned an invalid DNS record.");
    return result;
  });
}

function recordName(value) {
  const name = cleanText(value, 253).toLowerCase().replace(/\.$/, "");
  const qualified = name === RESEND_SENDING_DOMAIN || name.endsWith(`.${RESEND_SENDING_DOMAIN}`) ? name : `${name}.${RESEND_SENDING_DOMAIN}`;
  if (!name || !(qualified === RESEND_SENDING_DOMAIN || qualified.endsWith(`.${RESEND_SENDING_DOMAIN}`))) throw new AuthFailure(502, "resend_domain_record_scope_invalid", "Resend returned an out-of-scope DNS record.");
  return qualified;
}

function requireCanonicalSender(value) {
  const from = cleanText(value, 254);
  const match = from.match(/<([^<>]+)>$/);
  const address = cleanText(match?.[1] || from, 254).toLowerCase();
  if (!address.endsWith(`@${RESEND_SENDING_DOMAIN}`)) throw new AuthFailure(409, "resend_sender_domain_invalid", "The configured sender does not use the canonical Resend domain.");
}

function providerId(value) {
  const id = cleanText(value, 100);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new AuthFailure(502, "resend_domain_id_invalid", "Resend returned an invalid domain identifier.");
  return id;
}

function domainStatus(value) {
  const status = cleanText(value, 40).toLowerCase();
  return ["not_started", "pending", "verified", "failure", "temporary_failure"].includes(status) ? status : "unknown";
}

function publicEvidence(evidence) { return { id: evidence.id, domain: evidence.name, status: evidence.status, created: evidence.created, checkedAt: evidence.checkedAt, records: evidence.records.map(({ type, name, status, priority }) => ({ type, name, status, priority })) }; }
function setting(db, key, value, timestamp) { return db.prepare("INSERT INTO commerce_settings(setting_key,value_json,classification,updated_at,updated_by_account_id) VALUES (?,?,'safe',?,'commerce-operations-worker') ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,classification='safe',updated_at=excluded.updated_at,updated_by_account_id=excluded.updated_by_account_id").bind(key, JSON.stringify(value), timestamp); }
function json(value, fallback) { try { return JSON.parse(String(value ?? "")); } catch { return fallback; } }
