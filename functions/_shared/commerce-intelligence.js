import { AuthFailure, cleanText } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

const RANGE_HOURS = Object.freeze({ "24h": 24, "7d": 168, "30d": 720, "90d": 2160 });
const PAGE_SIZES = new Set([20, 50, 75, 100]);
const MAX_COHORT_ROWS = 5000;
const MAX_ITEM_ROWS = 20000;
const REQUIRED_SCHEMA = Object.freeze({
  commerce_orders: ["id", "customer_payment_provider", "payment_status", "currency_code", "customer_gross_amount", "stripe_fee_amount", "refund_amount", "printful_product_cost_amount", "printful_shipping_cost_amount", "printful_tax_amount", "printful_refund_credit_amount", "printful_order_id", "environment", "product_subtotal_amount", "shipping_amount", "tax_amount", "payment_confirmed_at", "created_at", "updated_at"],
  commerce_order_items: ["order_id", "product_id", "variant_id", "product_name", "variant_name", "currency_code", "unit_amount", "quantity", "line_total_amount"],
  commerce_donations: ["id", "environment", "currency_code", "amount_minor", "status", "completed_at", "refunded_at", "reversed_at", "created_at", "updated_at"],
  commerce_payment_attempts: ["commerce_order_id", "donation_id", "environment", "amount_minor", "normalized_state", "refunded_at", "reversed_at", "updated_at"],
});

export async function commerceIntelligenceReport(env, rawParams = {}, nowValue = new Date()) {
  const db = requireCommerceDb(env);
  const params = normalizeParams(rawParams);
  const now = validDate(nowValue);
  const hours = RANGE_HOURS[params.range];
  const currentStart = new Date(now.valueOf() - hours * 3_600_000);
  const previousStart = new Date(currentStart.valueOf() - hours * 3_600_000);
  await assertCommerceIntelligenceSchema(db);

  const lower = previousStart.toISOString();
  const upper = now.toISOString();
  const [orderResult, donationResult, attemptResult, itemResult, freshness] = await Promise.all([
    db.prepare(`SELECT id,customer_payment_provider,payment_status,currency_code,customer_gross_amount,
      product_subtotal_amount,shipping_amount,tax_amount,refund_amount,stripe_fee_amount,
      printful_product_cost_amount,printful_shipping_cost_amount,printful_tax_amount,printful_refund_credit_amount,
      printful_order_id,fulfillment_status,payment_confirmed_at,created_at,updated_at
      FROM commerce_orders WHERE environment='live' AND payment_status IN ('paid','partially_refunded','refunded','disputed')
      AND COALESCE(payment_confirmed_at,created_at)>=? AND COALESCE(payment_confirmed_at,created_at)<?
      ORDER BY COALESCE(payment_confirmed_at,created_at) DESC,id DESC LIMIT ?`).bind(lower, upper, MAX_COHORT_ROWS + 1).all(),
    db.prepare(`SELECT id,currency_code,amount_minor,status,completed_at,refunded_at,reversed_at,created_at,updated_at
      FROM commerce_donations WHERE environment='live' AND status IN ('completed','refunded','reversed')
      AND COALESCE(completed_at,created_at)>=? AND COALESCE(completed_at,created_at)<?
      ORDER BY COALESCE(completed_at,created_at) DESC,id DESC LIMIT ?`).bind(lower, upper, MAX_COHORT_ROWS + 1).all(),
    db.prepare(`SELECT a.commerce_order_id,a.donation_id,a.amount_minor,a.normalized_state,a.refunded_at,a.reversed_at,a.updated_at
      FROM commerce_payment_attempts a WHERE a.environment='live' AND a.normalized_state IN ('refunded','reversed')
      AND ((a.commerce_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM commerce_orders o WHERE o.id=a.commerce_order_id AND COALESCE(o.payment_confirmed_at,o.created_at)>=? AND COALESCE(o.payment_confirmed_at,o.created_at)<?))
        OR (a.donation_id IS NOT NULL AND EXISTS (SELECT 1 FROM commerce_donations d WHERE d.id=a.donation_id AND COALESCE(d.completed_at,d.created_at)>=? AND COALESCE(d.completed_at,d.created_at)<?)))
      ORDER BY a.updated_at DESC LIMIT ?`).bind(lower, upper, lower, upper, MAX_COHORT_ROWS + 1).all(),
    db.prepare(`SELECT i.order_id,i.product_id,i.variant_id,i.product_name,i.variant_name,i.currency_code,
      i.unit_amount,i.quantity,i.line_total_amount
      FROM commerce_order_items i JOIN commerce_orders o ON o.id=i.order_id
      WHERE o.environment='live' AND o.payment_status IN ('paid','partially_refunded','refunded','disputed')
      AND COALESCE(o.payment_confirmed_at,o.created_at)>=? AND COALESCE(o.payment_confirmed_at,o.created_at)<?
      ORDER BY COALESCE(o.payment_confirmed_at,o.created_at) DESC,i.line_number LIMIT ?`).bind(lower, upper, MAX_ITEM_ROWS + 1).all(),
    financialFreshness(db),
  ]);

  const rawOrders = rows(orderResult);
  const rawDonations = rows(donationResult);
  const rawAttempts = rows(attemptResult);
  const rawItems = rows(itemResult);
  const truncated = { orders: rawOrders.length > MAX_COHORT_ROWS, donations: rawDonations.length > MAX_COHORT_ROWS, attempts: rawAttempts.length > MAX_COHORT_ROWS, items: rawItems.length > MAX_ITEM_ROWS };
  const attempts = attemptEvidence(rawAttempts.slice(0, MAX_COHORT_ROWS));
  const orders = rawOrders.slice(0, MAX_COHORT_ROWS).map((row) => normalizeOrder(row, attempts.orders.get(row.id)));
  const donations = rawDonations.slice(0, MAX_COHORT_ROWS).map((row) => normalizeDonation(row, attempts.donations.get(row.id)));
  const items = rawItems.slice(0, MAX_ITEM_ROWS);
  const currentIso = currentStart.toISOString();
  const currentOrders = orders.filter((row) => row.capturedAt >= currentIso);
  const previousOrders = orders.filter((row) => row.capturedAt < currentIso);
  const currentDonations = donations.filter((row) => row.capturedAt >= currentIso);
  const previousDonations = donations.filter((row) => row.capturedAt < currentIso);
  const comparisonComplete = !truncated.orders && !truncated.donations && Boolean(freshness.oldestTransactionAt && freshness.oldestTransactionAt <= previousStart.toISOString());
  const current = summarizeCurrencies(currentOrders, currentDonations, !truncated.orders && !truncated.donations);
  const previous = summarizeCurrencies(previousOrders, previousDonations, !truncated.orders && !truncated.donations);
  const summaries = mergeComparisons(current, previous, comparisonComplete);
  const sortedOrders = [...currentOrders].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id));
  const totalPages = Math.ceil(sortedOrders.length / params.pageSize);
  const page = totalPages ? Math.min(params.page, totalPages) : 1;
  const start = (page - 1) * params.pageSize;

  return {
    ok: true,
    environment: "live",
    range: params.range,
    generatedAt: now.toISOString(),
    timezone: "UTC",
    currencyMode: summaries.length > 1 ? "multiple" : "single",
    currencies: summaries,
    trend: buildTrend(currentOrders, currentDonations, params.range),
    products: productPerformance(items, currentOrders, currentIso, truncated.items),
    orders: { items: sortedOrders.slice(start, start + params.pageSize).map(projectOrder), page, pageSize: params.pageSize, total: sortedOrders.length, totalPages, truncated: truncated.orders },
    donations: donationIntelligence(currentDonations),
    refunds: refundIntelligence(currentOrders, currentDonations),
    coverage: buildCoverage(currentOrders, currentDonations, freshness, truncated),
    semantics: {
      basis: "Captured transaction cohorts in the selected UTC window; persisted refund and reversal state is applied to those cohorts.",
      merchandise: "Persisted LIVE product subtotal only when subtotal, shipping, and tax reconcile exactly to the captured order total.",
      donations: "Persisted LIVE donations in completed, refunded, or reversed terminal collection states.",
      grossCollected: "Captured order totals plus captured donations; TEST and sandbox records are excluded.",
      netCollected: "Gross collected less persisted completed refunds and reversals. It is unavailable when a dispute has no authoritative reversal amount.",
      directCosts: "Positive provider-linked transaction cost fields only. Legacy zero defaults remain unknown.",
      processorFees: "Positive persisted transaction fee fields only; no fee schedules are estimated.",
      contributionMargin: "For fully evidenced merchandise orders only: net collected less tax, known provider costs, and known processor fees. It is not business profit.",
    },
  };
}

export async function commerceIntelligenceSchemaState(db) {
  const entries = await Promise.all(Object.entries(REQUIRED_SCHEMA).map(async ([table, required]) => {
    const result = await db.prepare(`PRAGMA table_info('${table}')`).all();
    const present = new Set(rows(result).map((row) => String(row.name || "")));
    return [table, { tablePresent: present.size > 0, missingColumns: required.filter((column) => !present.has(column)) }];
  }));
  const tables = Object.fromEntries(entries);
  return { compatible: Object.values(tables).every((entry) => entry.tablePresent && !entry.missingColumns.length), tables };
}

async function assertCommerceIntelligenceSchema(db) {
  const state = await commerceIntelligenceSchemaState(db);
  if (!state.compatible) throw new AuthFailure(503, "commerce_intelligence_migration_required", "Commerce Intelligence database migration required.");
}

function normalizeParams(input) {
  const range = String(input?.range || "30d");
  if (!Object.hasOwn(RANGE_HOURS, range)) throw new AuthFailure(400, "commerce_intelligence_range_invalid", "The Commerce Intelligence reporting range is invalid.");
  const page = Number(input?.page || 1);
  const pageSize = Number(input?.pageSize || 20);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new AuthFailure(400, "commerce_intelligence_page_invalid", "The Commerce Intelligence page is invalid.");
  if (!PAGE_SIZES.has(pageSize)) throw new AuthFailure(400, "commerce_intelligence_page_size_invalid", "The Commerce Intelligence page size is invalid.");
  return { range, page, pageSize };
}

function attemptEvidence(values) {
  const orders = new Map();
  const donations = new Map();
  for (const row of values) {
    const target = row.commerce_order_id ? orders : donations;
    const id = row.commerce_order_id || row.donation_id;
    if (!id || target.has(id)) continue;
    target.set(id, { state: row.normalized_state, amount: minor(row.amount_minor), at: cleanText(row.reversed_at || row.refunded_at || row.updated_at, 80) || null });
  }
  return { orders, donations };
}

function normalizeOrder(row, attempt) {
  const gross = minor(row.customer_gross_amount);
  const subtotal = minor(row.product_subtotal_amount);
  const shipping = minor(row.shipping_amount);
  const tax = minor(row.tax_amount);
  const allocationComplete = subtotal + shipping + tax === gross;
  const storedRefund = minor(row.refund_amount);
  const reversed = attempt?.state === "reversed" ? attempt.amount : null;
  const attemptedRefund = attempt?.state === "refunded" ? attempt.amount : null;
  let refundReversal = Math.max(storedRefund, attemptedRefund || 0, reversed || 0);
  let reversalComplete = true;
  if (row.payment_status === "disputed" && reversed === null) { refundReversal = null; reversalComplete = false; }
  const productCost = minor(row.printful_product_cost_amount);
  const providerCostRaw = productCost + minor(row.printful_shipping_cost_amount) + minor(row.printful_tax_amount) - minor(row.printful_refund_credit_amount);
  const providerCost = row.printful_order_id && providerCostRaw > 0 ? providerCostRaw : null;
  const processorFeeRaw = minor(row.stripe_fee_amount);
  const processorFee = cleanText(row.customer_payment_provider, 40).toLowerCase() === "stripe" && processorFeeRaw > 0 ? processorFeeRaw : null;
  const net = refundReversal === null ? null : Math.max(0, gross - refundReversal);
  const contributionMargin = providerCost !== null && processorFee !== null && net !== null && allocationComplete && refundReversal === 0 ? net - tax - providerCost - processorFee : null;
  return {
    id: cleanText(row.id, 160), kind: "merchandise", capturedAt: cleanText(row.payment_confirmed_at || row.created_at, 80), updatedAt: cleanText(row.updated_at, 80),
    status: cleanText(row.payment_status, 40), provider: cleanText(row.customer_payment_provider, 40), currencyCode: currency(row.currency_code), gross,
    merchandise: allocationComplete ? subtotal : null, shipping: allocationComplete ? shipping : null, tax: allocationComplete ? tax : null,
    refundReversal, reversalComplete, net, productCost: productCost > 0 && row.printful_order_id ? productCost : null, providerCost, processorFee, contributionMargin,
    allocationComplete, costKnown: providerCost !== null, feeKnown: processorFee !== null, fulfillmentStatus: cleanText(row.fulfillment_status, 40),
  };
}

function normalizeDonation(row, attempt) {
  const amount = minor(row.amount_minor);
  const terminalReversal = row.status === "refunded" || row.status === "reversed";
  const evidenceAt = row.status === "refunded" ? row.refunded_at : row.status === "reversed" ? row.reversed_at : row.completed_at;
  const reversalComplete = !terminalReversal || Boolean(evidenceAt || attempt?.at);
  return { id: cleanText(row.id, 160), kind: "donation", capturedAt: cleanText(row.completed_at || row.created_at, 80), updatedAt: cleanText(row.updated_at, 80), status: cleanText(row.status, 40), currencyCode: currency(row.currency_code), gross: amount, refundReversal: terminalReversal && reversalComplete ? amount : terminalReversal ? null : 0, reversalComplete, net: terminalReversal ? reversalComplete ? 0 : null : amount };
}

function summarizeCurrencies(orders, donations, bounded) {
  const codes = new Set([...orders.map((row) => row.currencyCode), ...donations.map((row) => row.currencyCode)]);
  return [...codes].sort().map((currencyCode) => summarizeCurrency(currencyCode, orders.filter((row) => row.currencyCode === currencyCode), donations.filter((row) => row.currencyCode === currencyCode), bounded));
}

function summarizeCurrency(currencyCode, orders, donations, bounded) {
  const transactions = [...orders, ...donations];
  const allocationComplete = bounded && orders.every((row) => row.allocationComplete);
  const reversalsComplete = bounded && transactions.every((row) => row.reversalComplete);
  const gross = sum(transactions, "gross");
  const knownReversals = sum(transactions.filter((row) => row.refundReversal !== null), "refundReversal");
  const knownCostOrders = orders.filter((row) => row.providerCost !== null);
  const knownFeeOrders = orders.filter((row) => row.processorFee !== null);
  const knownMarginOrders = orders.filter((row) => row.contributionMargin !== null);
  return {
    currencyCode,
    metrics: {
      merchandiseSales: metric(allocationComplete ? sum(orders, "merchandise") : null, sum(orders.filter((row) => row.merchandise !== null), "merchandise"), allocationComplete),
      donations: metric(sum(donations, "gross"), sum(donations, "gross"), bounded),
      customerShipping: metric(allocationComplete ? sum(orders, "shipping") : null, sum(orders.filter((row) => row.shipping !== null), "shipping"), allocationComplete),
      taxCollected: metric(allocationComplete ? sum(orders, "tax") : null, sum(orders.filter((row) => row.tax !== null), "tax"), allocationComplete),
      grossCollected: metric(bounded ? gross : null, gross, bounded),
      refundsReversals: metric(reversalsComplete ? knownReversals : null, knownReversals, reversalsComplete),
      netCollected: metric(reversalsComplete ? gross - knownReversals : null, gross - knownReversals, reversalsComplete),
      knownDirectCosts: metric(knownCostOrders.length === orders.length ? sum(knownCostOrders, "providerCost") : null, sum(knownCostOrders, "providerCost"), knownCostOrders.length === orders.length),
      processorFees: metric(knownFeeOrders.length === orders.length && donations.length === 0 ? sum(knownFeeOrders, "processorFee") : null, sum(knownFeeOrders, "processorFee"), knownFeeOrders.length === orders.length && donations.length === 0),
      contributionMargin: metric(knownMarginOrders.length === orders.length ? sum(knownMarginOrders, "contributionMargin") : null, sum(knownMarginOrders, "contributionMargin"), knownMarginOrders.length === orders.length),
      averageOrderValue: metric(orders.length && bounded ? Math.round(sum(orders, "gross") / orders.length) : orders.length ? null : 0, orders.length ? Math.round(sum(orders, "gross") / orders.length) : 0, bounded),
    },
    counts: { orders: orders.length, donations: donations.length, transactions: transactions.length, refundedOrders: orders.filter((row) => row.refundReversal > 0).length, disputes: orders.filter((row) => row.status === "disputed").length },
  };
}

function mergeComparisons(current, previous, complete) {
  const previousByCurrency = new Map(previous.map((entry) => [entry.currencyCode, entry]));
  return current.map((entry) => {
    const prior = previousByCurrency.get(entry.currencyCode) || emptyCurrency(entry.currencyCode);
    return { ...entry, comparisonComplete: complete, previous: prior, deltas: Object.fromEntries(Object.entries(entry.metrics).map(([key, value]) => [key, metricDelta(value, prior.metrics[key], complete)])) };
  });
}

function emptyCurrency(currencyCode) { return summarizeCurrency(currencyCode, [], [], true); }
function metric(value, knownValue, complete) { return { value, knownValue, complete }; }
function metricDelta(current, previous, complete) { if (!complete || !current?.complete || !previous?.complete) return { available: false, value: null, direction: "unavailable" }; const before = previous.value || 0; const now = current.value || 0; if (before === 0) return now === 0 ? { available: true, value: 0, direction: "neutral" } : { available: true, value: null, direction: "new" }; const value = (now - before) / before; return { available: true, value, direction: value > 0 ? "up" : value < 0 ? "down" : "neutral" }; }

function buildTrend(orders, donations, range) {
  const buckets = new Map();
  for (const row of [...orders, ...donations]) {
    const bucket = bucketKey(row.capturedAt, range);
    const key = `${row.currencyCode}\u0000${bucket}`;
    const entry = buckets.get(key) || { currencyCode: row.currencyCode, bucket, merchandise: 0, donations: 0, refundsReversals: 0, netCollected: 0, complete: true };
    if (row.kind === "merchandise") entry.merchandise += row.merchandise || 0; else entry.donations += row.gross;
    if (row.refundReversal === null) entry.complete = false; else entry.refundsReversals += row.refundReversal;
    if (row.net === null) entry.complete = false; else entry.netCollected += row.net;
    buckets.set(key, entry);
  }
  return [...buckets.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode) || a.bucket.localeCompare(b.bucket)).map((entry) => ({ ...entry, netCollected: entry.complete ? entry.netCollected : null }));
}

function productPerformance(items, orders, currentStart, itemTruncated) {
  const orderMap = new Map(orders.filter((row) => row.capturedAt >= currentStart).map((row) => [row.id, row]));
  const currentItems = items.filter((row) => orderMap.has(row.order_id));
  const lineCounts = new Map();
  for (const row of currentItems) lineCounts.set(row.order_id, (lineCounts.get(row.order_id) || 0) + 1);
  const groups = new Map();
  for (const row of currentItems) {
    const order = orderMap.get(row.order_id);
    const key = `${row.product_id}\u0000${row.variant_id || ""}`;
    const entry = groups.get(key) || { productId: cleanText(row.product_id, 160), variantId: cleanText(row.variant_id, 160) || null, product: cleanText(row.product_name, 240), variant: cleanText(row.variant_name, 240) || null, currencyCode: currency(row.currency_code), quantity: 0, grossMerchandise: 0, refundedValue: 0, refundedValueComplete: true, netMerchandise: 0, fulfillmentCost: 0, costCoveredOrders: 0, orderIds: new Set() };
    const lineTotal = minor(row.line_total_amount);
    entry.quantity += Math.max(0, Number(row.quantity) || 0);
    entry.grossMerchandise += lineTotal;
    entry.orderIds.add(order.id);
    if (order.refundReversal === null || (order.refundReversal > 0 && order.refundReversal < order.gross)) entry.refundedValueComplete = false;
    else { const refunded = order.refundReversal >= order.gross ? lineTotal : 0; entry.refundedValue += refunded; entry.netMerchandise += lineTotal - refunded; }
    if (lineCounts.get(order.id) === 1 && order.productCost !== null) { entry.fulfillmentCost += order.productCost; entry.costCoveredOrders += 1; }
    groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.grossMerchandise - a.grossMerchandise || a.product.localeCompare(b.product)).slice(0, 50).map((entry) => ({ productId: entry.productId, variantId: entry.variantId, product: entry.product, variant: entry.variant, currencyCode: entry.currencyCode, quantity: entry.quantity, grossMerchandise: entry.grossMerchandise, refundedValue: entry.refundedValueComplete ? entry.refundedValue : null, netMerchandise: entry.refundedValueComplete ? entry.netMerchandise : null, fulfillmentCost: entry.costCoveredOrders === entry.orderIds.size ? entry.fulfillmentCost : null, costCoverage: { knownOrders: entry.costCoveredOrders, totalOrders: entry.orderIds.size }, complete: !itemTruncated && entry.refundedValueComplete }));
}

function donationIntelligence(donations) {
  return [...groupByCurrency(donations).entries()].map(([currencyCode, rows]) => { const gross = sum(rows, "gross"); const reversalsComplete = rows.every((row) => row.reversalComplete); const reversed = sum(rows.filter((row) => row.refundReversal !== null), "refundReversal"); return { currencyCode, count: rows.length, gross, refundsReversals: reversalsComplete ? reversed : null, net: reversalsComplete ? gross - reversed : null, average: rows.length ? Math.round(gross / rows.length) : 0, complete: reversalsComplete }; });
}

function refundIntelligence(orders, donations) {
  return [...new Set([...orders.map((row) => row.currencyCode), ...donations.map((row) => row.currencyCode)])].sort().map((currencyCode) => { const orderRows = orders.filter((row) => row.currencyCode === currencyCode); const donationRows = donations.filter((row) => row.currencyCode === currencyCode); const refunded = orderRows.filter((row) => row.refundReversal > 0); const denominator = orderRows.reduce((total, row) => total + row.gross, 0); const knownRefunds = sum(refunded, "refundReversal"); return { currencyCode, orderRefunds: refunded.length, fullOrderRefunds: refunded.filter((row) => row.refundReversal >= row.gross).length, partialOrderRefunds: refunded.filter((row) => row.refundReversal < row.gross).length, refundValue: orderRows.every((row) => row.reversalComplete) ? knownRefunds : null, refundRate: denominator && orderRows.every((row) => row.reversalComplete) ? knownRefunds / denominator : null, refundRateBasis: "Completed order refunds and reversals divided by captured order value in the selected cohort.", donationRefunds: donationRows.filter((row) => row.status === "refunded").length, donationReversals: donationRows.filter((row) => row.status === "reversed").length, disputes: orderRows.filter((row) => row.status === "disputed").length, unresolvedDisputes: orderRows.filter((row) => row.status === "disputed" && !row.reversalComplete).length }; });
}

function buildCoverage(orders, donations, freshness, truncated) {
  const reversedDonations = donations.filter((row) => row.status === "refunded" || row.status === "reversed");
  return { orders: orders.length, fulfillmentCost: { known: orders.filter((row) => row.costKnown).length, unknown: orders.filter((row) => !row.costKnown).length }, processorFees: { known: orders.filter((row) => row.feeKnown).length, unknown: orders.filter((row) => !row.feeKnown).length + donations.length }, allocation: { complete: orders.filter((row) => row.allocationComplete).length, incomplete: orders.filter((row) => !row.allocationComplete).length }, donationReversals: { complete: reversedDonations.filter((row) => row.reversalComplete).length, incomplete: reversedDonations.filter((row) => !row.reversalComplete).length }, unresolvedDisputes: orders.filter((row) => row.status === "disputed" && !row.reversalComplete).length, currencies: [...new Set([...orders.map((row) => row.currencyCode), ...donations.map((row) => row.currencyCode)])].sort(), oldestTransactionAt: freshness.oldestTransactionAt, latestTransactionAt: freshness.latestTransactionAt, latestFinancialUpdateAt: freshness.latestFinancialUpdateAt, latestProviderUpdateAt: freshness.latestProviderUpdateAt, truncated, complete: !Object.values(truncated).some(Boolean) };
}

function projectOrder(row) { return { id: row.id, capturedAt: row.capturedAt, status: row.status, provider: row.provider, fulfillmentStatus: row.fulfillmentStatus, currencyCode: row.currencyCode, charged: row.gross, merchandise: row.merchandise, customerShipping: row.shipping, tax: row.tax, refundReversal: row.refundReversal, netCollected: row.net, fulfillmentCost: row.providerCost, processorFee: row.processorFee, contributionMargin: row.contributionMargin, completeness: row.contributionMargin !== null ? "complete" : !row.reversalComplete || !row.allocationComplete ? "financial_evidence_incomplete" : "direct_costs_incomplete" }; }

async function financialFreshness(db) {
  const [orders, donations, provider] = await Promise.all([
    db.prepare("SELECT MIN(COALESCE(payment_confirmed_at,created_at)) oldest,MAX(COALESCE(payment_confirmed_at,created_at)) latest,MAX(updated_at) updated FROM commerce_orders WHERE environment='live' AND payment_status IN ('paid','partially_refunded','refunded','disputed')").first(),
    db.prepare("SELECT MIN(COALESCE(completed_at,created_at)) oldest,MAX(COALESCE(completed_at,created_at)) latest,MAX(updated_at) updated FROM commerce_donations WHERE environment='live' AND status IN ('completed','refunded','reversed')").first(),
    db.prepare("SELECT MAX(last_provider_evidence_at) latest FROM commerce_fulfillment_orders WHERE environment='live'").first().catch(() => null),
  ]);
  const values = [orders?.oldest, donations?.oldest].filter(Boolean).sort();
  const latest = [orders?.latest, donations?.latest].filter(Boolean).sort().at(-1) || null;
  const updated = [orders?.updated, donations?.updated].filter(Boolean).sort().at(-1) || null;
  return { oldestTransactionAt: values[0] || null, latestTransactionAt: latest, latestFinancialUpdateAt: updated, latestProviderUpdateAt: provider?.latest || null };
}

function bucketKey(value, range) { const date = validDate(value); if (range === "24h") return date.toISOString().slice(0, 13) + ":00:00.000Z"; if (range !== "90d") return date.toISOString().slice(0, 10) + "T00:00:00.000Z"; const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() - day + 1); date.setUTCHours(0, 0, 0, 0); return date.toISOString(); }
function groupByCurrency(values) { const map = new Map(); for (const value of values) map.set(value.currencyCode, [...(map.get(value.currencyCode) || []), value]); return map; }
function sum(values, field) { return values.reduce((total, row) => total + Number(row[field] || 0), 0); }
function minor(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function currency(value) { const code = String(value || "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(code) ? code : "UNK"; }
function validDate(value) { const date = value instanceof Date ? value : new Date(String(value || "")); if (Number.isNaN(date.valueOf())) throw new AuthFailure(400, "commerce_intelligence_date_invalid", "The Commerce Intelligence reporting date is invalid."); return date; }
function rows(result) { return result?.results || []; }

export { MAX_COHORT_ROWS, MAX_ITEM_ROWS, RANGE_HOURS as COMMERCE_INTELLIGENCE_RANGES, REQUIRED_SCHEMA as COMMERCE_INTELLIGENCE_REQUIRED_SCHEMA };
