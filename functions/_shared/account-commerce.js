import {
  AuthFailure,
  cleanText,
  enforceRateLimit,
  hmacSha256,
  loadAccountById,
  normalizeOrigin,
  nowIso,
  randomId,
  serializeAccount,
  timingSafeEqual,
} from "./auth-core.js";
import {
  decryptCommerceSecret,
  encryptCommerceSecret,
  requireCommerceDb,
  writeCommerceAudit,
} from "./commerce-core.js";
import {
  normalizeCustomerEmail,
  prepareCheckoutCustomer,
  validateCheckoutCustomer,
} from "./commerce-customers.js";
import { fulfillmentDetailForOrder } from "./printful-fulfillment.js";
import { normalizeDeliveryRecipient } from "./shipping-core.js";

const encoder = new TextEncoder();
const MAX_ADDRESSES = 10;
const MAX_INTERNAL_BODY_BYTES = 24 * 1024;

export async function verifyAccountCommerceInternalRequest(request, env, rawBody) {
  const publicOrigin = normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN);
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!publicOrigin || origin !== publicOrigin) {
    throw new AuthFailure(403, "origin_not_allowed", "This account-commerce request origin is not allowed.");
  }
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!secret || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new AuthFailure(401, "internal_signature_invalid", "The account-commerce request could not be verified.");
  }
  const digest = await digestHex(encoder.encode(rawBody));
  const pathname = new URL(request.url).pathname;
  const expected = await hmacSha256(secret, `${timestamp}\n${request.method}\n${pathname}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) {
    throw new AuthFailure(401, "internal_signature_invalid", "The account-commerce request could not be verified.");
  }
}

export async function readAccountCommerceInternalBody(request) {
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    throw new AuthFailure(415, "content_type_invalid", "A JSON account-commerce request is required.");
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_INTERNAL_BODY_BYTES) {
    throw new AuthFailure(413, "request_too_large", "The account-commerce request is too large.");
  }
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_INTERNAL_BODY_BYTES) {
    throw new AuthFailure(413, "request_too_large", "The account-commerce request is too large.");
  }
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { throw new AuthFailure(400, "invalid_json", "The account-commerce request is invalid."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthFailure(400, "invalid_json", "The account-commerce request is invalid.");
  return { body, raw };
}

export async function accountCommerceOverview(env, accountId) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await customerForAccount(db, account.id);
  const [addresses, orders, settings] = await Promise.all([
    customer ? addressRows(env, db, customer.id) : [],
    customer ? accountOrders(env, customer.id, { limit: 3 }) : emptyOrderList(),
    checkoutReadiness(db),
  ]);
  return {
    ok: true,
    authority: "Admin Commerce D1",
    linked: Boolean(customer),
    contact: await contactProjection(env, account, customer),
    addresses,
    orders: orders.orders,
    summary: {
      savedAddressCount: addresses.length,
      orderCount: orders.total,
      liveOrderCount: orders.liveCount,
      testOrderCount: orders.testCount,
    },
    checkout: settings,
  };
}

export async function accountCommerceContactUpdate(env, accountId, input) {
  assertOnlyFields(input, new Set(["name", "phone", "revision"]), "contact_fields_invalid");
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await ensureAccountCustomer(env, db, account);
  const revision = positiveRevision(input.revision);
  const name = requiredPlainText(input.name, 2, 120, "contact_name_invalid");
  const phone = optionalPhone(input.phone);
  const [nameCiphertext, phoneCiphertext] = await Promise.all([
    encryptCommerceSecret(env, name, `customer:${customer.id}:name`),
    phone ? encryptCommerceSecret(env, phone, `customer:${customer.id}:phone`) : Promise.resolve(null),
  ]);
  const timestamp = nowIso();
  const result = await db.prepare(`UPDATE commerce_customers
    SET contact_name_ciphertext=?,contact_phone_ciphertext=?,revision=revision+1,updated_at=?
    WHERE id=? AND customer_kind='account' AND linked_account_id=? AND revision=?`)
    .bind(nameCiphertext, phoneCiphertext, timestamp, customer.id, account.id, revision).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "contact_revision_conflict", "Contact details changed. Reload before saving.");
  await writeCommerceAudit(env, { actorAccountId: account.id, action: "account_contact_updated", targetType: "commerce_customer", targetId: customer.id, result: "success", metadata: { phoneConfigured: Boolean(phone) } });
  return accountCommerceOverview(env, account.id);
}

export async function accountAddressCreate(env, accountId, input) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await ensureAccountCustomer(env, db, account);
  const count = Number((await db.prepare("SELECT COUNT(*) count FROM commerce_saved_addresses WHERE customer_id=? AND lifecycle='active'").bind(customer.id).first())?.count || 0);
  if (count >= MAX_ADDRESSES) throw new AuthFailure(409, "address_limit_reached", `Up to ${MAX_ADDRESSES} saved addresses are supported.`);
  const address = normalizeSavedAddress(input, false);
  const id = `adr_${randomId()}`;
  const ciphertext = await encryptCommerceSecret(env, JSON.stringify(address.private), `saved-address:${id}`);
  const timestamp = nowIso();
  const makeDefault = count === 0 || address.isDefault;
  const statements = [];
  if (makeDefault) statements.push(db.prepare("UPDATE commerce_saved_addresses SET is_default=0,revision=revision+1,updated_at=? WHERE customer_id=? AND lifecycle='active' AND is_default=1").bind(timestamp, customer.id));
  statements.push(db.prepare(`INSERT INTO commerce_saved_addresses
    (id,customer_id,label,address_ciphertext,country_code,is_default,lifecycle,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?)`).bind(id, customer.id, address.label, ciphertext, address.private.countryCode, makeDefault ? 1 : 0, timestamp, timestamp));
  await db.batch(statements);
  await writeCommerceAudit(env, { actorAccountId: account.id, action: "saved_address_created", targetType: "commerce_saved_address", targetId: id, result: "success", metadata: { default: makeDefault, addressCount: count + 1 } });
  return accountCommerceOverview(env, account.id);
}

export async function accountAddressUpdate(env, accountId, addressId, input) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await requireAccountCustomer(db, account.id);
  const id = validAddressId(addressId);
  const existing = await ownedAddress(db, customer.id, id);
  const address = normalizeSavedAddress(input, true);
  if (address.revision !== Number(existing.revision)) throw new AuthFailure(409, "address_revision_conflict", "This saved address changed. Reload before saving.");
  const ciphertext = await encryptCommerceSecret(env, JSON.stringify(address.private), `saved-address:${id}`);
  const timestamp = nowIso();
  const statements = [];
  if (address.isDefault) statements.push(db.prepare("UPDATE commerce_saved_addresses SET is_default=0,revision=revision+1,updated_at=? WHERE customer_id=? AND lifecycle='active' AND is_default=1 AND id<>?").bind(timestamp, customer.id, id));
  statements.push(db.prepare(`UPDATE commerce_saved_addresses
    SET label=?,address_ciphertext=?,country_code=?,is_default=?,revision=revision+1,updated_at=?
    WHERE id=? AND customer_id=? AND lifecycle='active' AND revision=?`)
    .bind(address.label, ciphertext, address.private.countryCode, address.isDefault || existing.is_default === 1 ? 1 : 0, timestamp, id, customer.id, address.revision));
  const result = await db.batch(statements);
  if (Number(result.at(-1)?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "address_revision_conflict", "This saved address changed. Reload before saving.");
  await writeCommerceAudit(env, { actorAccountId: account.id, action: "saved_address_updated", targetType: "commerce_saved_address", targetId: id, result: "success", metadata: { default: address.isDefault || existing.is_default === 1 } });
  return accountCommerceOverview(env, account.id);
}

export async function accountAddressDelete(env, accountId, addressId) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await requireAccountCustomer(db, account.id);
  const id = validAddressId(addressId);
  const existing = await ownedAddress(db, customer.id, id);
  const replacement = existing.is_default === 1
    ? await db.prepare("SELECT id FROM commerce_saved_addresses WHERE customer_id=? AND lifecycle='active' AND id<>? ORDER BY created_at ASC,id ASC LIMIT 1").bind(customer.id, id).first()
    : null;
  const statements = [db.prepare("DELETE FROM commerce_saved_addresses WHERE id=? AND customer_id=? AND lifecycle='active'").bind(id, customer.id)];
  if (replacement?.id) statements.push(db.prepare("UPDATE commerce_saved_addresses SET is_default=1,revision=revision+1,updated_at=? WHERE id=? AND customer_id=? AND lifecycle='active'").bind(nowIso(), replacement.id, customer.id));
  const result = await db.batch(statements);
  if (Number(result[0]?.meta?.changes || 0) !== 1) throw new AuthFailure(404, "saved_address_not_found", "This saved address was not found.");
  await writeCommerceAudit(env, { actorAccountId: account.id, action: "saved_address_deleted", targetType: "commerce_saved_address", targetId: id, result: "success", metadata: { reassignedDefault: Boolean(replacement?.id), historicalOrderSnapshotsChanged: false } });
  return accountCommerceOverview(env, account.id);
}

export async function accountAddressSetDefault(env, accountId, addressId) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await requireAccountCustomer(db, account.id);
  const id = validAddressId(addressId);
  await ownedAddress(db, customer.id, id);
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE commerce_saved_addresses SET is_default=0,revision=revision+1,updated_at=? WHERE customer_id=? AND lifecycle='active' AND is_default=1 AND id<>?").bind(timestamp, customer.id, id),
    db.prepare("UPDATE commerce_saved_addresses SET is_default=1,revision=revision+1,updated_at=? WHERE id=? AND customer_id=? AND lifecycle='active' AND is_default=0").bind(timestamp, id, customer.id),
  ]);
  await writeCommerceAudit(env, { actorAccountId: account.id, action: "saved_address_default_changed", targetType: "commerce_saved_address", targetId: id, result: "success", metadata: {} });
  return accountCommerceOverview(env, account.id);
}

export async function accountOrderHistory(env, accountId, input = {}) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await customerForAccount(db, account.id);
  if (!customer) return { ok: true, authority: "Admin Commerce D1", ...emptyOrderList() };
  return { ok: true, authority: "Admin Commerce D1", ...(await accountOrders(env, customer.id, { limit: boundedLimit(input.limit) })) };
}

export async function accountOrderDetail(env, accountId, rawOrderId) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const customer = await requireAccountCustomer(db, account.id);
  const orderId = validOrderId(rawOrderId);
  const order = await db.prepare(`SELECT id,environment,checkout_status,payment_status,fulfillment_status,currency_code,
    customer_gross_amount,refund_amount,created_at,updated_at,checkout_created_at,payment_confirmed_at,payment_failed_at
    FROM commerce_orders WHERE id=? AND customer_id=? LIMIT 1`).bind(orderId, customer.id).first();
  if (!order) throw new AuthFailure(404, "account_order_not_found", "This order was not found for your account.");
  const [itemsResult, deliveryRow, fulfillment] = await Promise.all([
    db.prepare(`SELECT i.id,i.line_number,i.product_id,i.variant_id,i.product_name,i.variant_name,i.option_values_json,
      i.currency_code,i.unit_amount,i.quantity,i.line_total_amount,
      json_extract(p.safe_metadata_json,'$.publicImage') current_image_url
      FROM commerce_order_items i LEFT JOIN commerce_products p ON p.id=i.product_id
      WHERE i.order_id=? ORDER BY i.line_number ASC`).bind(order.id).all(),
    db.prepare(`SELECT recipient_ciphertext,destination_country_code,destination_region_code,display_shipping_method,
      shipping_amount,currency_code,quoted_at,created_at FROM commerce_order_delivery_snapshots WHERE order_id=? LIMIT 1`).bind(order.id).first(),
    fulfillmentDetailForOrder(env, order.id, { includeTracking: true }),
  ]);
  const items = (itemsResult?.results || []).map(publicOrderItem);
  const subtotalAmount = items.reduce((sum, item) => sum + item.lineTotalAmount, 0);
  const snapshot = deliveryRow?.recipient_ciphertext
    ? safeJson(await decryptCommerceSecret(env, deliveryRow.recipient_ciphertext, `order-delivery:${order.id}`), null)
    : null;
  const shippingAmount = deliveryRow ? safeMinor(deliveryRow.shipping_amount) : null;
  const totalAmount = safeMinor(order.customer_gross_amount);
  const refundAmount = safeMinor(order.refund_amount);
  return {
    ok: true,
    authority: "Admin Commerce D1",
    order: {
      id: order.id,
      reference: orderReference(order.id),
      environment: order.environment === "live" ? "live" : "test",
      checkoutStatus: cleanText(order.checkout_status, 40),
      paymentStatus: cleanText(order.payment_status, 40),
      fulfillmentStatus: publicFulfillmentState(fulfillment, order.fulfillment_status),
      currencyCode: "CAD",
      createdAt: cleanText(order.created_at, 80),
      updatedAt: cleanText(order.updated_at, 80),
      paymentConfirmedAt: cleanText(order.payment_confirmed_at, 80) || null,
      items,
      financial: {
        subtotalAmount,
        shippingAmount,
        taxAmount: null,
        totalAmount,
        refundAmount,
        netAmount: refundAmount <= totalAmount ? totalAmount - refundAmount : null,
        currencyCode: "CAD",
      },
      delivery: deliveryRow ? {
        address: publicSnapshotAddress(snapshot),
        method: cleanText(deliveryRow.display_shipping_method, 100),
        amount: shippingAmount,
        currencyCode: "CAD",
        capturedAt: cleanText(deliveryRow.created_at, 80),
        historicalSnapshot: true,
        externallyVerified: false,
      } : null,
      shipments: publicShipments(fulfillment),
      timeline: orderTimeline(order, fulfillment),
    },
  };
}

export async function accountInboxMessages(env, accountId, input = {}) {
  const account = await requireActiveAccount(env, accountId);
  const db = requireCommerceDb(env);
  const unreadOnly = input.unread === true || input.unread === "true";
  const state = unreadOnly ? "AND s.read_at IS NULL" : "";
  const [result, counts] = await Promise.all([
    db.prepare(`SELECT m.id,m.category,m.source_type,m.source_id,m.title,m.preview,m.body_text,m.action_url,m.action_label,m.detail_json,m.created_at,m.expires_at,s.read_at
      FROM account_inbox_messages m LEFT JOIN account_inbox_states s ON s.message_id=m.id AND s.account_id=?
      WHERE m.account_id=? AND s.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) ${state}
      ORDER BY m.created_at DESC LIMIT 100`).bind(account.id, account.id, nowIso()).all(),
    db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN s.read_at IS NULL THEN 1 ELSE 0 END) unread
      FROM account_inbox_messages m LEFT JOIN account_inbox_states s ON s.message_id=m.id AND s.account_id=?
      WHERE m.account_id=? AND s.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)`).bind(account.id, account.id, nowIso()).first(),
  ]);
  return { ok: true, authority: "Admin Commerce D1", items: (result?.results || []).map(accountInboxProjection), total: Number(counts?.total || 0), unread: Number(counts?.unread || 0) };
}

export async function mutateAccountInbox(env, accountId, input = {}) {
  const account = await requireActiveAccount(env, accountId);
  assertOnlyFields(input, new Set(["ids", "action"]), "account_inbox_fields_invalid");
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map((id) => cleanText(id, 80)).filter((id) => /^[A-Za-z0-9_-]{16,80}$/.test(id)))].slice(0, 100) : [];
  const action = cleanText(input.action, 20);
  if (!ids.length || !new Set(["read", "unread", "delete"]).has(action)) throw new AuthFailure(400, "account_inbox_mutation_invalid", "Select at least one valid message and action.");
  const db = requireCommerceDb(env);
  const placeholders = ids.map(() => "?").join(",");
  const owned = await db.prepare(`SELECT id FROM account_inbox_messages WHERE account_id=? AND id IN (${placeholders})`).bind(account.id, ...ids).all();
  const allowed = (owned?.results || []).map((row) => row.id);
  if (!allowed.length) throw new AuthFailure(404, "account_inbox_message_not_found", "The selected message was not found.");
  const timestamp = nowIso();
  for (const id of allowed) {
    if (action === "unread") await db.prepare(`INSERT INTO account_inbox_states(message_id,account_id,read_at,deleted_at,updated_at) VALUES(?,?,NULL,NULL,?) ON CONFLICT(message_id,account_id) DO UPDATE SET read_at=NULL,updated_at=excluded.updated_at WHERE account_inbox_states.deleted_at IS NULL`).bind(id, account.id, timestamp).run();
    else await db.prepare(`INSERT INTO account_inbox_states(message_id,account_id,read_at,deleted_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(message_id,account_id) DO UPDATE SET read_at=excluded.read_at,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at`).bind(id, account.id, timestamp, action === "delete" ? timestamp : null, timestamp).run();
  }
  return { ok: true, action, updated: allowed.length };
}

function accountInboxProjection(row) {
  return { id: cleanText(row.id, 80), category: cleanText(row.category, 40), sourceType: cleanText(row.source_type, 80), sourceId: cleanText(row.source_id, 160), title: cleanText(row.title, 160), preview: cleanText(row.preview, 320), body: cleanText(row.body_text, 4000), actionUrl: safeAccountPath(row.action_url), actionLabel: cleanText(row.action_label, 60) || null, details: safeJson(row.detail_json, {}), createdAt: cleanText(row.created_at, 80), expiresAt: cleanText(row.expires_at, 80) || null, readAt: cleanText(row.read_at, 80) || null, unread: !row.read_at };
}

function safeAccountPath(value) { const path = cleanText(value, 512); return /^\/(?!api\/)[a-z0-9/_?&=.%:-]*$/i.test(path) ? path : null; }

async function requireActiveAccount(env, rawAccountId) {
  const accountId = cleanText(rawAccountId, 160);
  if (!accountId) throw new AuthFailure(401, "account_required", "A signed-in account is required.");
  const row = await loadAccountById(env, accountId);
  const account = await serializeAccount(env, row);
  if (!account || account.status !== "active") throw new AuthFailure(401, "account_unavailable", "The signed-in account is unavailable.");
  return account;
}

async function ensureAccountCustomer(env, db, account) {
  const existing = await customerForAccount(db, account.id);
  if (existing) return existing;
  if (!account.email) throw new AuthFailure(409, "account_email_required", "A primary account email is required before saving commerce contact details.");
  const contact = validateCheckoutCustomer({ mode: "account", name: account.displayName, email: normalizeCustomerEmail(account.email) }, { accountId: account.id });
  const prepared = await prepareCheckoutCustomer(env, db, contact);
  await db.batch([prepared.statement, ...(prepared.auditStatement ? [prepared.auditStatement] : [])]);
  return db.prepare("SELECT * FROM commerce_customers WHERE id=? LIMIT 1").bind(prepared.id).first();
}

async function customerForAccount(db, accountId) {
  return db.prepare("SELECT * FROM commerce_customers WHERE customer_kind='account' AND linked_account_id=? LIMIT 1").bind(accountId).first();
}

async function requireAccountCustomer(db, accountId) {
  const customer = await customerForAccount(db, accountId);
  if (!customer) throw new AuthFailure(404, "commerce_customer_not_linked", "No commerce customer is linked to this account yet.");
  return customer;
}

async function contactProjection(env, account, customer) {
  if (!customer) return { name: account.displayName, phone: null, email: account.email, emailVerified: account.emailVerified, revision: null };
  const [name, phone] = await Promise.all([
    decryptCommerceSecret(env, customer.contact_name_ciphertext, `customer:${customer.id}:name`),
    customer.contact_phone_ciphertext ? decryptCommerceSecret(env, customer.contact_phone_ciphertext, `customer:${customer.id}:phone`) : Promise.resolve(null),
  ]);
  return { name: cleanText(name, 120), phone: cleanText(phone, 32) || null, email: account.email, emailVerified: account.emailVerified, revision: Number(customer.revision || 1) };
}

async function addressRows(env, db, customerId) {
  const result = await db.prepare(`SELECT id,label,address_ciphertext,country_code,is_default,revision,created_at,updated_at
    FROM commerce_saved_addresses WHERE customer_id=? AND lifecycle='active' ORDER BY is_default DESC,created_at ASC,id ASC`).bind(customerId).all();
  return Promise.all((result?.results || []).map(async (row) => {
    const value = safeJson(await decryptCommerceSecret(env, row.address_ciphertext, `saved-address:${row.id}`), {});
    return {
      id: row.id, label: cleanText(row.label, 40), recipientName: cleanText(value.recipientName, 120), company: cleanText(value.company, 120) || null,
      address1: cleanText(value.address1, 180), address2: cleanText(value.address2, 180) || null,
      city: cleanText(value.city, 120), region: cleanText(value.region, 80) || null,
      postalCode: cleanText(value.postalCode, 24), countryCode: cleanText(value.countryCode || row.country_code, 2).toUpperCase(),
      phone: cleanText(value.phone, 32) || null, isDefault: row.is_default === 1, revision: Number(row.revision || 1),
      createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80), externallyVerified: false,
    };
  }));
}

function normalizeSavedAddress(input, updating) {
  const allowed = new Set(["label", "recipientName", "company", "address1", "address2", "city", "region", "postalCode", "countryCode", "phone", "isDefault", "revision"]);
  assertOnlyFields(input, allowed, "saved_address_fields_invalid");
  const revision = updating ? positiveRevision(input.revision) : null;
  const label = requiredPlainText(input.label, 1, 40, "saved_address_label_invalid");
  const company = optionalPlainText(input.company, 120, "saved_address_company_invalid");
  const delivery = normalizeDeliveryRecipient({
    name: input.recipientName,
    address1: input.address1,
    address2: input.address2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    countryCode: input.countryCode,
    phone: input.phone,
  });
  return {
    label,
    isDefault: input.isDefault === true,
    revision,
    private: {
      recipientName: delivery.name, company, address1: delivery.address1, address2: delivery.address2,
      city: delivery.city, region: delivery.region, postalCode: delivery.postalCode,
      countryCode: delivery.countryCode, phone: delivery.phone,
    },
  };
}

async function ownedAddress(db, customerId, addressId) {
  const row = await db.prepare("SELECT * FROM commerce_saved_addresses WHERE id=? AND customer_id=? AND lifecycle='active' LIMIT 1").bind(addressId, customerId).first();
  if (!row) throw new AuthFailure(404, "saved_address_not_found", "This saved address was not found.");
  return row;
}

async function accountOrders(env, customerId, { limit }) {
  const db = requireCommerceDb(env);
  const [result, counts] = await Promise.all([
    db.prepare(`SELECT o.id,o.environment,o.checkout_status,o.payment_status,o.fulfillment_status,o.currency_code,
      o.customer_gross_amount,o.refund_amount,o.created_at,o.updated_at,o.payment_confirmed_at,
      COALESCE((SELECT SUM(i.quantity) FROM commerce_order_items i WHERE i.order_id=o.id),0) item_count,
      COALESCE(f.fulfillment_state,'unfulfilled') normalized_fulfillment_state,
      EXISTS(SELECT 1 FROM commerce_fulfillment_shipments s WHERE s.fulfillment_order_id=f.id AND s.tracking_available=1) tracking_available
      FROM commerce_orders o LEFT JOIN commerce_fulfillment_orders f ON f.order_id=o.id AND f.provider='printful'
      WHERE o.customer_id=? ORDER BY o.created_at DESC,o.id ASC LIMIT ?`).bind(customerId, limit).all(),
    db.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN environment='live' THEN 1 ELSE 0 END),0) live_count,
      COALESCE(SUM(CASE WHEN environment='test' THEN 1 ELSE 0 END),0) test_count
      FROM commerce_orders WHERE customer_id=?`).bind(customerId).first(),
  ]);
  return {
    orders: (result?.results || []).map((row) => ({
      id: row.id, reference: orderReference(row.id), environment: row.environment === "live" ? "live" : "test",
      orderStatus: cleanText(row.checkout_status, 40), paymentStatus: cleanText(row.payment_status, 40),
      fulfillmentStatus: cleanText(row.normalized_fulfillment_state || row.fulfillment_status, 40),
      itemCount: Number(row.item_count || 0), totalAmount: safeMinor(row.customer_gross_amount), refundAmount: safeMinor(row.refund_amount),
      currencyCode: "CAD", createdAt: cleanText(row.created_at, 80), updatedAt: cleanText(row.updated_at, 80),
      paymentConfirmedAt: cleanText(row.payment_confirmed_at, 80) || null, trackingAvailable: row.tracking_available === 1,
    })),
    total: Number(counts?.total || 0), liveCount: Number(counts?.live_count || 0), testCount: Number(counts?.test_count || 0),
  };
}

async function checkoutReadiness(db) {
  const result = await db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled','shipping_strategy')").all();
  const settings = Object.fromEntries((result?.results || []).map((row) => [row.setting_key, safeJson(row.value_json, null)]));
  return {
    enabled: settings.checkout_enabled === true,
    livePaymentCaptureEnabled: settings.live_payment_capture_enabled === true,
    fulfillmentSubmissionEnabled: settings.fulfillment_submission_enabled === true,
    shippingConfigured: typeof settings.shipping_strategy === "string" && settings.shipping_strategy !== "unconfigured",
    message: settings.checkout_enabled === true ? "Checkout is available when the server confirms all prerequisites." : "Checkout is currently unavailable. No order or payment can be created.",
  };
}

function publicOrderItem(row) {
  return {
    id: cleanText(row.id, 160), productId: cleanText(row.product_id, 160), variantId: cleanText(row.variant_id, 160) || null,
    title: cleanText(row.product_name, 240), variant: cleanText(row.variant_name, 240) || null,
    options: safeJson(row.option_values_json, {}), image: safeHttpsUrl(row.current_image_url),
    unitAmount: safeMinor(row.unit_amount), quantity: Number(row.quantity || 0), lineTotalAmount: safeMinor(row.line_total_amount), currencyCode: "CAD",
  };
}

function publicSnapshotAddress(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    recipientName: cleanText(snapshot.name, 120), company: cleanText(snapshot.company, 120) || null,
    address1: cleanText(snapshot.address1, 180), address2: cleanText(snapshot.address2, 180) || null,
    city: cleanText(snapshot.city, 120), region: cleanText(snapshot.region, 80) || null,
    postalCode: cleanText(snapshot.postalCode, 24), countryCode: cleanText(snapshot.countryCode, 2).toUpperCase(),
    phone: cleanText(snapshot.phone, 32) || null,
  };
}

function publicShipments(fulfillment) {
  return (fulfillment?.shipments || []).map((shipment) => ({
    id: cleanText(shipment.id, 160), state: cleanText(shipment.state, 40), carrier: cleanText(shipment.carrier, 80) || null,
    service: cleanText(shipment.service, 80) || null, trackingAvailable: shipment.trackingAvailable === true,
    trackingReference: cleanText(shipment.trackingReference, 180) || null, trackingUrl: safeHttpsUrl(shipment.trackingUrl),
    shippedAt: cleanText(shipment.shippedAt, 80) || null, deliveredAt: cleanText(shipment.deliveredAt, 80) || null,
  }));
}

function orderTimeline(order, fulfillment) {
  const events = [{ at: order.created_at, label: "Order recorded", state: cleanText(order.checkout_status, 40) }];
  if (order.payment_confirmed_at) events.push({ at: order.payment_confirmed_at, label: "Payment confirmed", state: "paid" });
  if (order.payment_failed_at) events.push({ at: order.payment_failed_at, label: "Payment not completed", state: "failed" });
  for (const shipment of fulfillment?.shipments || []) {
    if (shipment.shippedAt) events.push({ at: shipment.shippedAt, label: "Shipment recorded", state: cleanText(shipment.state, 40) });
    if (shipment.deliveredAt) events.push({ at: shipment.deliveredAt, label: "Delivery recorded", state: "delivered" });
  }
  return events.filter((event) => event.at).sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

function publicFulfillmentState(fulfillment, fallback) {
  return cleanText(fulfillment?.fulfillmentState, 40) || cleanText(fallback, 40) || "unfulfilled";
}

function assertOnlyFields(input, allowed, code) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AuthFailure(400, code, "The supplied account-commerce fields are invalid.");
  }
}

function requiredPlainText(value, minimum, maximum, code) {
  const raw = String(value ?? "");
  if (/\r|\n|[\u0000-\u001f\u007f]|[<>]/.test(raw)) throw new AuthFailure(400, code, "This field contains unsupported characters.");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new AuthFailure(400, code, `Enter between ${minimum} and ${maximum} characters.`);
  return normalized;
}

function optionalPlainText(value, maximum, code) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return requiredPlainText(value, 1, maximum, code);
}

function optionalPhone(value) {
  const phone = optionalPlainText(value, 32, "contact_phone_invalid");
  if (!phone) return null;
  if (!/^[0-9+().\-\s]{7,32}$/.test(phone)) throw new AuthFailure(400, "contact_phone_invalid", "Enter a valid optional telephone number.");
  return phone;
}

function positiveRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647) throw new AuthFailure(400, "revision_invalid", "A current revision is required.");
  return revision;
}

function validAddressId(value) {
  const id = cleanText(value, 80);
  if (!/^adr_[0-9a-f-]{36}$/.test(id)) throw new AuthFailure(400, "saved_address_id_invalid", "The saved address identifier is invalid.");
  return id;
}

function validOrderId(value) {
  const id = cleanText(value, 160);
  if (!/^ord_[A-Za-z0-9_-]{1,150}$/.test(id)) throw new AuthFailure(400, "account_order_id_invalid", "The order identifier is invalid.");
  return id;
}

function boundedLimit(value) {
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;
}

function orderReference(id) { return `TR-${String(id).replace(/^ord_/, "").slice(-8).toUpperCase()}`; }
function safeMinor(value) { const amount = Number(value); return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0; }
function emptyOrderList() { return { orders: [], total: 0, liveCount: 0, testCount: 0 }; }
function safeJson(value, fallback) { try { return JSON.parse(String(value)); } catch { return fallback; } }
function safeHttpsUrl(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" && !url.username && !url.password ? url.toString().slice(0, 2048) : null; } catch { return null; } }
async function digestHex(bytes) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export async function enforceAccountCommerceRateLimit(env, request, accountId) {
  return enforceRateLimit(env, request, "commerce", cleanText(accountId, 160));
}

export { MAX_ADDRESSES, normalizeSavedAddress };
