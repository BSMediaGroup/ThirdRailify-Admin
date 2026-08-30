import {
  AuthFailure,
  cleanText,
  hmacSha256,
  nowIso,
  randomId,
  requireAuthDb,
  serializeAccount,
} from "./auth-core.js";
import {
  commerceAccessForSession,
  decryptCommerceSecret,
  encryptCommerceSecret,
  requireCommerceDb,
} from "./commerce-core.js";

const PAGE_SIZES = new Set([20, 50, 75, 100]);
const CUSTOMER_SORTS = new Set(["latest_order", "oldest", "newest", "highest_live_spend", "most_orders"]);
const PAID_STATUSES = new Set(["paid"]);

export function validateCheckoutCustomer(input, session) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthFailure(400, "checkout_customer_invalid", "Customer contact details are required.");
  }
  if (Object.keys(input).some((key) => !new Set(["mode", "name", "email"]).has(key))) {
    throw new AuthFailure(400, "checkout_customer_fields_invalid", "Customer contact details contain unsupported fields.");
  }
  const mode = input.mode === "guest" || input.mode === "account" ? input.mode : "";
  if (!mode) throw new AuthFailure(400, "checkout_customer_mode_invalid", "Choose guest or account checkout.");
  if (mode === "account" && !session?.accountId) {
    throw new AuthFailure(401, "checkout_account_session_required", "Sign in again to purchase with your account.");
  }
  if (mode === "guest" && session?.accountId) {
    throw new AuthFailure(409, "checkout_account_mode_required", "Signed-in purchases must use the authenticated account.");
  }
  const name = requiredContactName(input.name);
  const email = normalizeCustomerEmail(input.email);
  return { mode, name, email, accountId: mode === "account" ? session.accountId : null };
}

export async function prepareCheckoutCustomer(env, db, contact) {
  const fingerprint = await customerEmailFingerprint(env, contact.email);
  const existing = contact.mode === "account"
    ? await db.prepare("SELECT * FROM commerce_customers WHERE customer_kind='account' AND linked_account_id=? LIMIT 1").bind(contact.accountId).first()
    : await db.prepare("SELECT * FROM commerce_customers WHERE customer_kind='guest' AND contact_email_fingerprint=? LIMIT 1").bind(fingerprint).first();
  const timestamp = nowIso();
  const id = existing?.id || `cst_${randomId()}`;
  const [nameCiphertext, emailCiphertext] = await Promise.all([
    encryptCommerceSecret(env, contact.name, `customer:${id}:name`),
    encryptCommerceSecret(env, contact.email, `customer:${id}:email`),
  ]);
  const statement = existing
    ? db.prepare(`UPDATE commerce_customers SET contact_name_ciphertext=?,contact_email_ciphertext=?,
        contact_email_fingerprint=?,revision=revision+1,updated_at=? WHERE id=?`)
      .bind(nameCiphertext, emailCiphertext, fingerprint, timestamp, id)
    : db.prepare(`INSERT INTO commerce_customers
        (id,customer_kind,linked_account_id,contact_name_ciphertext,contact_email_ciphertext,contact_email_fingerprint,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, contact.mode, contact.accountId, nameCiphertext, emailCiphertext, fingerprint, timestamp, timestamp);
  const auditStatement = existing ? null : db.prepare(`INSERT INTO commerce_audit
      (id,actor_account_id,action,target_type,target_id,result,metadata_json,created_at)
      VALUES (?,? ,?,'commerce_customer',?,'success',?,?)`)
    .bind(randomId(), contact.accountId, contact.mode === "account" ? "commerce_customer_account_linked" : "commerce_customer_created", id, JSON.stringify({ customerKind: contact.mode }), timestamp);
  return { id, kind: contact.mode, accountId: contact.accountId, contact: { name: contact.name, email: contact.email }, statement, auditStatement, created: !existing };
}

export async function customerListPayload(env, session, input = {}) {
  const access = await commerceAccessForSession(env, session);
  const options = normalizeCustomerListOptions(input);
  if (!env?.THIRDRAILIFY_COMMERCE_DB) return emptyCustomerList(access, options);
  const db = requireCommerceDb(env);
  const search = await customerSearchScope(env, options.query);
  const { sql, params } = customerWhere(options, search);
  const cte = customerStatsCte();
  const count = await db.prepare(`${cte} SELECT COUNT(*) total FROM customer_stats c ${sql}`).bind(...params).first();
  const totalMatching = Number(count?.total || 0);
  const totalPages = totalMatching ? Math.ceil(totalMatching / options.pageSize) : 0;
  const page = totalPages ? Math.min(options.page, totalPages) : 1;
  const offset = (page - 1) * options.pageSize;
  const result = await db.prepare(`${cte}
    SELECT c.* FROM customer_stats c ${sql}
    ORDER BY ${customerSortSql(options.sort)}, c.id ASC LIMIT ? OFFSET ?`)
    .bind(...params, options.pageSize, offset).all();
  const rows = result?.results || [];
  const accounts = await accountMap(env, rows.map((row) => row.linked_account_id));
  const customers = await Promise.all(rows.map((row) => serializeCustomerRow(env, row, accounts.get(row.linked_account_id))));
  return {
    ok: true, databaseConfigured: true, authority: "Commerce D1", access, customers,
    page, pageSize: options.pageSize, totalMatching, totalPages,
    startIndex: totalMatching ? offset + 1 : 0, endIndex: totalMatching ? offset + customers.length : 0,
    filters: { query: options.query, type: options.type, environment: options.environment, purchase: options.purchase, sort: options.sort },
  };
}

export async function customerDetailPayload(env, session, rawCustomerId, input = {}) {
  const access = await commerceAccessForSession(env, session);
  const db = requireCommerceDb(env);
  const customerId = validCustomerId(rawCustomerId);
  const pageSize = PAGE_SIZES.has(Number(input.pageSize)) ? Number(input.pageSize) : 20;
  const requestedPage = boundedInteger(input.page, 1, 1_000_000, 1);
  const row = await db.prepare(`${customerStatsCte()} SELECT * FROM customer_stats WHERE id=? LIMIT 1`).bind(customerId).first();
  if (!row) throw new AuthFailure(404, "commerce_customer_not_found", "The commerce customer was not found.");
  const totalPages = Number(row.total_orders || 0) ? Math.ceil(Number(row.total_orders) / pageSize) : 0;
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const offset = (page - 1) * pageSize;
  const [ordersResult, accountResult, donationsResult] = await Promise.all([
    db.prepare(`SELECT o.id,o.environment,o.payment_status,o.fulfillment_status,o.currency_code,
        o.customer_gross_amount,o.refund_amount,o.created_at,o.payment_confirmed_at,
        d.destination_country_code,d.destination_region_code,d.display_shipping_method,
        f.fulfillment_state normalized_fulfillment_state,
        (SELECT COUNT(*) FROM commerce_fulfillment_shipments fs WHERE fs.fulfillment_order_id=f.id) shipment_count,
        EXISTS(SELECT 1 FROM commerce_fulfillment_shipments fs WHERE fs.fulfillment_order_id=f.id AND fs.tracking_available=1) tracking_available,
        (SELECT COUNT(*) FROM commerce_order_documents od WHERE od.order_id=o.id) document_count,
        (SELECT COUNT(*) FROM commerce_email_deliveries ed WHERE ed.order_id=o.id) email_count
      FROM commerce_orders o LEFT JOIN commerce_order_delivery_snapshots d ON d.order_id=o.id
      LEFT JOIN commerce_fulfillment_orders f ON f.order_id=o.id AND f.provider='printful'
      WHERE o.customer_id=? ORDER BY o.created_at DESC,o.id ASC LIMIT ? OFFSET ?`)
      .bind(customerId, pageSize, offset).all(),
    row.linked_account_id ? accountMap(env, [row.linked_account_id]) : Promise.resolve(new Map()),
    db.prepare("SELECT id,environment,amount_minor,status,created_at,completed_at FROM commerce_donations WHERE customer_id=? ORDER BY created_at DESC LIMIT 100").bind(customerId).all(),
  ]);
  const customer = await serializeCustomerRow(env, row, accountResult.get(row.linked_account_id));
  return {
    ok: true, databaseConfigured: true, authority: "Commerce D1", access,
    customer: {
      ...customer,
      orders: (ordersResult?.results || []).map(serializeCustomerOrder),
      donations: (donationsResult?.results || []).map((donation) => ({ id:cleanText(donation.id,80),environment:donation.environment === "live" ? "live" : "sandbox",amount:Number(donation.amount_minor||0),currencyCode:"CAD",status:cleanText(donation.status,40),createdAt:cleanText(donation.created_at,80),completedAt:cleanText(donation.completed_at,80)||null })),
      orderPage: page, orderPageSize: pageSize, orderTotalPages: totalPages,
      communication: {
        documents: (ordersResult?.results || []).reduce((sum, order) => sum + Number(order.document_count || 0), 0),
        deliveries: (ordersResult?.results || []).reduce((sum, order) => sum + Number(order.email_count || 0), 0),
        boundedToVisibleOrders: true,
      },
      technical: { revision: Number(row.revision), linkedAccountId: cleanText(row.linked_account_id, 160) || null },
    },
  };
}

export async function customerSummaryByAccountIds(env, accountIds) {
  const ids = [...new Set((accountIds || []).map((value) => cleanText(value, 160)).filter(Boolean))].slice(0, 500);
  if (!ids.length || !env?.THIRDRAILIFY_COMMERCE_DB) return new Map();
  const result = await requireCommerceDb(env).prepare(`${customerStatsCte()}
    SELECT id,linked_account_id,total_orders,last_order_at FROM customer_stats
    WHERE customer_kind='account' AND linked_account_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all();
  return new Map((result?.results || []).map((row) => [row.linked_account_id, {
    id: cleanText(row.id, 80), orderCount: Number(row.total_orders || 0), lastOrderAt: cleanText(row.last_order_at, 80) || null,
  }]));
}

export async function orderCustomerProjection(env, rawCustomerId) {
  const customerId = cleanText(rawCustomerId, 80);
  if (!customerId) return { linked: false, legacy: true, id: null, kind: null, contact: null, account: null };
  const row = await requireCommerceDb(env).prepare("SELECT * FROM commerce_customers WHERE id=? LIMIT 1").bind(customerId).first();
  if (!row) return { linked: false, legacy: true, id: customerId, kind: null, contact: null, account: null };
  const accounts = row.linked_account_id ? await accountMap(env, [row.linked_account_id]) : new Map();
  const serialized = await serializeCustomerRow(env, row, accounts.get(row.linked_account_id));
  return { linked: true, legacy: false, id: serialized.id, kind: serialized.kind, contact: serialized.contact, account: serialized.account };
}

async function serializeCustomerRow(env, row, account) {
  const [name, email] = await Promise.all([
    decryptCommerceSecret(env, row.contact_name_ciphertext, `customer:${row.id}:name`),
    decryptCommerceSecret(env, row.contact_email_ciphertext, `customer:${row.id}:email`),
  ]);
  return {
    id: cleanText(row.id, 80), kind: row.customer_kind === "account" ? "account" : "guest",
    contact: { name: cleanText(name, 120), email: normalizeCustomerEmail(email) },
    account: account ? compactAccount(account) : null,
    createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80), revision: Number(row.revision || 1),
    summary: {
      orderCount: Number(row.total_orders || 0), paidOrderCount: Number(row.paid_orders || 0),
      liveOrderCount: Number(row.live_orders || 0), testOrderCount: Number(row.test_orders || 0),
      livePaidOrderCount: Number(row.live_paid_orders || 0), testPaidOrderCount: Number(row.test_paid_orders || 0),
      liveSpendAmount: Number(row.live_spend_amount || 0), testSpendAmount: Number(row.test_spend_amount || 0),
      donationCount: Number(row.donation_count || 0), completedDonationCount: Number(row.completed_donations || 0),
      liveDonationAmount: Number(row.live_donation_amount || 0), sandboxDonationAmount: Number(row.sandbox_donation_amount || 0),
      currencyCode: "CAD", firstOrderAt: cleanText(row.first_order_at, 80) || null, lastOrderAt: cleanText(row.last_order_at, 80) || null,
    },
  };
}

async function accountMap(env, rawIds) {
  const ids = [...new Set((rawIds || []).map((value) => cleanText(value, 160)).filter(Boolean))].slice(0, 500);
  if (!ids.length || !env?.THIRDRAILIFY_AUTH_DB) return new Map();
  const db = requireAuthDb(env);
  const placeholders = ids.map(() => "?").join(",");
  const [accountsResult, identitiesResult] = await Promise.all([
    db.prepare(`SELECT * FROM accounts WHERE id IN (${placeholders})`).bind(...ids).all(),
    db.prepare(`SELECT provider,provider_subject,provider_username,provider_email,provider_email_verified,account_id
      FROM auth_identities WHERE account_id IN (${placeholders}) ORDER BY created_at ASC`).bind(...ids).all(),
  ]);
  const identities = new Map();
  for (const identity of identitiesResult?.results || []) {
    const list = identities.get(identity.account_id) || []; list.push(identity); identities.set(identity.account_id, list);
  }
  const entries = await Promise.all((accountsResult?.results || []).map(async (row) => [row.id, await serializeAccount(env, row, { identities: identities.get(row.id) || [] })]));
  return new Map(entries);
}

async function customerSearchScope(env, query) {
  if (!query) return { emailFingerprint: null, accountIds: [] };
  const emailFingerprint = looksLikeEmail(query) ? await customerEmailFingerprint(env, query) : null;
  if (!env?.THIRDRAILIFY_AUTH_DB) return { emailFingerprint, accountIds: [] };
  const pattern = `%${escapeLike(query.toLowerCase())}%`;
  const result = await requireAuthDb(env).prepare(`SELECT DISTINCT a.id FROM accounts a
    LEFT JOIN auth_identities i ON i.account_id=a.id
    WHERE lower(a.id) LIKE ? ESCAPE '\\' OR lower(a.display_name) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(a.email_normalized,'')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(i.provider_username,'')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(i.provider_subject,'')) LIKE ? ESCAPE '\\'
    ORDER BY a.created_at DESC LIMIT 100`).bind(pattern, pattern, pattern, pattern, pattern).all();
  return { emailFingerprint, accountIds: (result?.results || []).map((row) => row.id) };
}

function customerWhere(options, search) {
  const conditions = [];
  const params = [];
  if (options.type !== "all") { conditions.push("c.customer_kind=?"); params.push(options.type); }
  if (options.environment !== "all") {
    conditions.push(`EXISTS (SELECT 1 FROM commerce_orders oe WHERE oe.customer_id=c.id AND oe.environment=?)`); params.push(options.environment);
  }
  if (options.purchase === "paid") conditions.push("c.paid_orders>0");
  if (options.purchase === "unpaid") conditions.push("c.paid_orders=0");
  if (options.query) {
    const pieces = ["lower(c.id) LIKE ? ESCAPE '\\'"]; params.push(`%${escapeLike(options.query.toLowerCase())}%`);
    if (search.emailFingerprint) { pieces.push("c.contact_email_fingerprint=?"); params.push(search.emailFingerprint); }
    if (search.accountIds.length) { pieces.push(`c.linked_account_id IN (${search.accountIds.map(() => "?").join(",")})`); params.push(...search.accountIds); }
    conditions.push(`(${pieces.join(" OR ")})`);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function customerStatsCte() {
  return `WITH customer_stats AS (
    SELECT c.*,
      COUNT(o.id) total_orders,
      COALESCE(SUM(CASE WHEN o.payment_status='paid' THEN 1 ELSE 0 END),0) paid_orders,
      COALESCE(SUM(CASE WHEN o.environment='live' THEN 1 ELSE 0 END),0) live_orders,
      COALESCE(SUM(CASE WHEN o.environment='test' THEN 1 ELSE 0 END),0) test_orders,
      COALESCE(SUM(CASE WHEN o.environment='live' AND o.payment_status='paid' THEN 1 ELSE 0 END),0) live_paid_orders,
      COALESCE(SUM(CASE WHEN o.environment='test' AND o.payment_status='paid' THEN 1 ELSE 0 END),0) test_paid_orders,
      COALESCE(SUM(CASE WHEN o.environment='live' AND o.payment_status='paid' THEN o.customer_gross_amount ELSE 0 END),0) live_spend_amount,
      COALESCE(SUM(CASE WHEN o.environment='test' AND o.payment_status='paid' THEN o.customer_gross_amount ELSE 0 END),0) test_spend_amount,
      MIN(o.created_at) first_order_at,MAX(o.created_at) last_order_at
      ,(SELECT COUNT(*) FROM commerce_donations d WHERE d.customer_id=c.id) donation_count
      ,(SELECT COUNT(*) FROM commerce_donations d WHERE d.customer_id=c.id AND d.status='completed') completed_donations
      ,(SELECT COALESCE(SUM(d.amount_minor),0) FROM commerce_donations d WHERE d.customer_id=c.id AND d.environment='live' AND d.status='completed') live_donation_amount
      ,(SELECT COALESCE(SUM(d.amount_minor),0) FROM commerce_donations d WHERE d.customer_id=c.id AND d.environment='sandbox' AND d.status='completed') sandbox_donation_amount
    FROM commerce_customers c LEFT JOIN commerce_orders o ON o.customer_id=c.id GROUP BY c.id
  )`;
}

function serializeCustomerOrder(row) {
  return {
    id: cleanText(row.id, 160), environment: row.environment === "live" ? "live" : "test",
    paymentStatus: cleanText(row.payment_status, 40), fulfillmentStatus: cleanText(row.fulfillment_status, 40),
    totalAmount: safeMinor(row.customer_gross_amount), refundAmount: safeMinor(row.refund_amount), currencyCode: "CAD",
    createdAt: cleanText(row.created_at, 80), paymentConfirmedAt: cleanText(row.payment_confirmed_at, 80) || null,
    delivery: row.destination_country_code ? { countryCode: cleanText(row.destination_country_code, 2), regionCode: cleanText(row.destination_region_code, 80) || null, method: cleanText(row.display_shipping_method, 100) || null, historicalSnapshot: true } : null,
    documentCount: Number(row.document_count || 0), emailCount: Number(row.email_count || 0),
    fulfillment: { state: cleanText(row.normalized_fulfillment_state, 40) || "unfulfilled", shipped: new Set(["shipped", "delivered", "returned"]).has(row.normalized_fulfillment_state), trackingAvailable: row.tracking_available === 1, shipmentCount: Number(row.shipment_count || 0) },
  };
}

function normalizeCustomerListOptions(input) {
  const type = ["all", "account", "guest"].includes(input.type) ? input.type : "all";
  const environment = ["all", "live", "test"].includes(input.environment) ? input.environment : "all";
  const purchase = ["any", "paid", "unpaid"].includes(input.purchase) ? input.purchase : "any";
  const sort = CUSTOMER_SORTS.has(input.sort) ? input.sort : "latest_order";
  return { page: boundedInteger(input.page, 1, 1_000_000, 1), pageSize: PAGE_SIZES.has(Number(input.pageSize)) ? Number(input.pageSize) : 20, query: cleanText(input.query, 120), type, environment, purchase, sort };
}

function customerSortSql(sort) {
  if (sort === "oldest") return "c.created_at ASC";
  if (sort === "newest") return "c.created_at DESC";
  if (sort === "highest_live_spend") return "c.live_spend_amount DESC,c.last_order_at DESC";
  if (sort === "most_orders") return "c.total_orders DESC,c.last_order_at DESC";
  return "c.last_order_at DESC,c.created_at DESC";
}

async function customerEmailFingerprint(env, rawEmail) {
  const secret = cleanText(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET, 4096);
  if (!secret) throw new AuthFailure(503, "customer_identity_protection_unavailable", "Customer identity protection is not configured.");
  return hmacSha256(secret, `commerce-customer-email:v1\n${normalizeCustomerEmail(rawEmail)}`);
}

function normalizeCustomerEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new AuthFailure(400, "checkout_customer_email_invalid", "Enter a valid customer email address.");
  }
  return email;
}

function requiredContactName(value) {
  const name = cleanText(value, 120).replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new AuthFailure(400, "checkout_customer_name_invalid", "Enter the customer's name.");
  return name;
}
function compactAccount(account) { return { id: account.id, displayName: account.displayName, email: account.email, username: account.username, avatarUrl: account.avatarUrl, providers: account.providers, role: account.role, adminLevel: account.adminLevel, status: account.status, emailVerified: account.emailVerified, createdAt: account.createdAt, lastLoginAt: account.lastLoginAt, source: account.source }; }
function validCustomerId(value) { const id = cleanText(value, 80); if (!/^cst_[0-9a-f-]{36}$/.test(id)) throw new AuthFailure(400, "commerce_customer_id_invalid", "The commerce customer identifier is invalid."); return id; }
function boundedInteger(value, minimum, maximum, fallback) { const number = Number(value); return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback; }
function safeMinor(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function looksLikeEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function escapeLike(value) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }
function emptyCustomerList(access, options) { return { ok: true, databaseConfigured: false, authority: "Commerce D1 unavailable", access, customers: [], page: 1, pageSize: options.pageSize, totalMatching: 0, totalPages: 0, startIndex: 0, endIndex: 0, filters: { query: options.query, type: options.type, environment: options.environment, purchase: options.purchase, sort: options.sort } }; }

export { normalizeCustomerEmail };
