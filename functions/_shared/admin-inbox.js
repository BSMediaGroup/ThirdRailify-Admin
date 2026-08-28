import { AuthFailure, cleanText, nowIso, randomId } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

const PAGE_SIZE = 50;

export function adminInboxMessageStatement(env, input, timestamp = nowIso()) {
  const sourceType = required(input.sourceType, 80);
  const sourceId = required(input.sourceId, 160);
  return requireCommerceDb(env).prepare(
    `INSERT OR IGNORE INTO admin_inbox_messages
      (id, category, source_type, source_id, title, preview, body_text, action_url, action_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    randomId(), cleanText(input.category, 40) || "operations", sourceType, sourceId,
    required(input.title, 160), required(input.preview, 320), required(input.bodyText, 4000),
    safeAdminPath(input.actionUrl), cleanText(input.actionLabel, 60) || null, timestamp,
  );
}

export async function adminInboxSummary(env, accountIdValue) {
  const db = requireCommerceDb(env);
  const accountId = required(accountIdValue, 160);
  const [unread, latest, submissions, comments, failedEmails] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM admin_inbox_messages m
      WHERE NOT EXISTS (SELECT 1 FROM admin_inbox_reads r WHERE r.message_id = m.id AND r.account_id = ?)`)
      .bind(accountId).first(),
    db.prepare(`${messageSelect()} ORDER BY m.created_at DESC LIMIT 3`).bind(accountId).all(),
    db.prepare("SELECT COUNT(*) AS count FROM community_submissions WHERE status = 'pending'").first(),
    db.prepare("SELECT COUNT(*) AS count FROM community_comments WHERE moderation_state = 'pending' AND status <> 'deleted'").first(),
    db.prepare("SELECT COUNT(*) AS count FROM community_email_outbox WHERE status = 'failed'").first(),
  ]);
  const goats = {
    submissions: Number(submissions?.count || 0),
    comments: Number(comments?.count || 0),
    emailFailures: Number(failedEmails?.count || 0),
  };
  goats.total = goats.submissions + goats.comments + goats.emailFailures;
  return { ok: true, unread: Number(unread?.count || 0), actionable: { goats, total: goats.total }, latest: (latest?.results || []).map(messageProjection) };
}

export async function adminInboxMessages(env, accountIdValue, input = {}) {
  const db = requireCommerceDb(env);
  const accountId = required(accountIdValue, 160);
  const unreadOnly = input.unread === true || input.unread === "true";
  const page = boundedInteger(input.page, 1, 10_000, 1);
  const pageSize = boundedInteger(input.pageSize, 1, 100, PAGE_SIZE);
  const unreadClause = unreadOnly ? "WHERE r.message_id IS NULL" : "";
  const [rows, count] = await Promise.all([
    db.prepare(`${messageSelect()} ${unreadClause} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).bind(accountId, pageSize, (page - 1) * pageSize).all(),
    db.prepare(`SELECT COUNT(*) AS count FROM admin_inbox_messages m LEFT JOIN admin_inbox_reads r ON r.message_id = m.id AND r.account_id = ? ${unreadClause}`).bind(accountId).first(),
  ]);
  return { ok: true, items: (rows?.results || []).map(messageProjection), page, pageSize, total: Number(count?.count || 0), unreadOnly };
}

export async function markAdminInboxRead(env, accountIdValue, messageIdValue) {
  const db = requireCommerceDb(env);
  const accountId = required(accountIdValue, 160);
  const messageId = required(messageIdValue, 36);
  const exists = await db.prepare("SELECT id FROM admin_inbox_messages WHERE id = ?").bind(messageId).first();
  if (!exists) throw new AuthFailure(404, "inbox_message_not_found", "The inbox message was not found.");
  await db.prepare("INSERT INTO admin_inbox_reads (message_id, account_id, read_at) VALUES (?, ?, ?) ON CONFLICT(message_id, account_id) DO UPDATE SET read_at = excluded.read_at").bind(messageId, accountId, nowIso()).run();
  return { ok: true };
}

export async function markAllAdminInboxRead(env, accountIdValue) {
  const db = requireCommerceDb(env);
  const accountId = required(accountIdValue, 160);
  const timestamp = nowIso();
  await db.prepare(`INSERT OR IGNORE INTO admin_inbox_reads (message_id, account_id, read_at)
    SELECT id, ?, ? FROM admin_inbox_messages`).bind(accountId, timestamp).run();
  return { ok: true, readAt: timestamp };
}

function messageSelect() {
  return `SELECT m.id, m.category, m.source_type, m.source_id, m.title, m.preview, m.body_text,
    m.action_url, m.action_label, m.created_at, m.resolved_at, r.read_at
    FROM admin_inbox_messages m LEFT JOIN admin_inbox_reads r ON r.message_id = m.id AND r.account_id = ?`;
}

function messageProjection(row) {
  return {
    id: row.id, category: row.category, sourceType: row.source_type, sourceId: row.source_id,
    title: row.title, preview: row.preview, body: row.body_text, actionUrl: row.action_url,
    actionLabel: row.action_label, createdAt: row.created_at, resolvedAt: row.resolved_at,
    readAt: row.read_at, unread: !row.read_at,
  };
}

function required(value, max) {
  const result = cleanText(value, max);
  if (!result) throw new AuthFailure(400, "inbox_message_invalid", "The inbox message is invalid.");
  return result;
}

function safeAdminPath(value) {
  const path = cleanText(value, 512);
  return /^\/[a-z0-9/_?&=.%:-]*$/i.test(path) ? path : null;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}
