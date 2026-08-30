import {
  AuthFailure,
  cleanText,
  loadAccountById,
  nowIso,
  randomId,
  serializeAccount,
} from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

export async function createAccountTransactionalMessage(env, rawAccountId, input) {
  const accountId = cleanText(rawAccountId, 160);
  const account = accountId ? await serializeAccount(env, await loadAccountById(env, accountId)) : null;
  if (!account || account.status !== "active") throw new AuthFailure(401, "account_unavailable", "The transactional message recipient is unavailable.");
  const value = transactionalMessageInput(input);
  const db = requireCommerceDb(env);
  await accountTransactionalMessageStatement(db, account.id, value).run();
  const row = await db.prepare("SELECT id FROM account_inbox_messages WHERE account_id=? AND source_type=? AND source_id=? LIMIT 1").bind(account.id, value.sourceType, value.sourceId).first();
  return { ok: true, delivered: true, accountId: account.id, messageId: cleanText(row?.id, 80) };
}

export function accountTransactionalMessageStatement(db, rawAccountId, input) {
  const accountId = cleanText(rawAccountId, 160);
  if (!accountId) throw new AuthFailure(400, "account_message_recipient_invalid", "A canonical account recipient is required.");
  const value = transactionalMessageInput(input);
  return db.prepare(`INSERT INTO account_inbox_messages(
      id,account_id,category,source_type,source_id,title,preview,body_text,action_url,action_label,detail_json,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,source_type,source_id) DO UPDATE SET
      category=excluded.category,title=excluded.title,preview=excluded.preview,body_text=excluded.body_text,
      action_url=excluded.action_url,action_label=excluded.action_label,detail_json=excluded.detail_json,expires_at=excluded.expires_at`)
    .bind(`message_${randomId()}`, accountId, value.category, value.sourceType, value.sourceId, value.title, value.preview, value.body,
      value.actionUrl, value.actionLabel, JSON.stringify(value.details), value.createdAt, value.expiresAt);
}

function transactionalMessageInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !new Set(["category", "sourceType", "sourceId", "title", "preview", "body", "actionUrl", "actionLabel", "details", "createdAt", "expiresAt"]).has(key))) {
    throw new AuthFailure(400, "account_message_fields_invalid", "The transactional message fields are invalid.");
  }
  const actionUrl = cleanText(input.actionUrl, 512) || null;
  if (actionUrl && !/^\/(?!api\/)[a-z0-9/_?&=.%:-]*$/i.test(actionUrl)) throw new AuthFailure(400, "account_message_action_invalid", "The transactional message action is invalid.");
  const details = input.details && typeof input.details === "object" && !Array.isArray(input.details) ? input.details : {};
  const safeDetails = Object.fromEntries(Object.entries(details).slice(0, 20).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [key, typeof value === "string" ? cleanText(value, 240) : value]));
  return {
    category: required(input.category, 40, "account_message_category_invalid"),
    sourceType: required(input.sourceType, 80, "account_message_source_invalid"),
    sourceId: required(input.sourceId, 160, "account_message_source_invalid"),
    title: required(input.title, 160, "account_message_title_invalid"),
    preview: required(input.preview, 320, "account_message_preview_invalid"),
    body: required(input.body, 4000, "account_message_body_invalid"),
    actionUrl,
    actionLabel: cleanText(input.actionLabel, 60) || null,
    details: safeDetails,
    createdAt: validTimestamp(input.createdAt) || nowIso(),
    expiresAt: input.expiresAt ? validTimestamp(input.expiresAt) : null,
  };
}

function required(value, maximum, code) {
  const text = cleanText(value, maximum);
  if (!text) throw new AuthFailure(400, code, "A required transactional message field is invalid.");
  return text;
}

function validTimestamp(value) {
  const text = cleanText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}
