import { AuthFailure, nowIso } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";
import { transactionGuard, LAUNCH_AUTHORITY_SQL } from "./commerce-transaction-guards.js";

const MAX = 2147483647;
function fail(code, message) { throw new AuthFailure(409, code, message); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum && value <= MAX; }
export function weightToMilligrams(value, unit) {
  const scale = { mg: 1n, g: 1000n, kg: 1000000n }[unit];
  const match = String(value).match(/^(\d{1,10})(?:\.(\d{1,6}))?$/);
  if (!scale || !match) fail("shipping_weight_invalid", "Enter an exact positive weight in mg, g or kg.");
  const denominator = 10n ** BigInt((match[2] || "").length);
  const numerator = BigInt(match[1] + (match[2] || "")) * scale;
  if (numerator % denominator || !integer(Number(numerator / denominator), 1)) fail("shipping_weight_invalid", "Weight must be positive and exactly representable in milligrams.");
  return Number(numerator / denominator);
}

export function validateRatebook(book, supportedCountries) {
  if (!book || book.currency !== "CAD" || !Array.isArray(book.zones) || !book.zones.length || book.zones.length > 100 || !Array.isArray(book.exclusions)) fail("shipping_ratebook_invalid", "A CAD ratebook with destination zones is required.");
  const countries = new Set(supportedCountries), assigned = new Set(), ids = new Set();
  let worldwide = 0;
  for (const code of book.exclusions) if (!countries.has(code)) fail("shipping_destination_invalid", "Exclusions must use supported canonical country codes.");
  for (const zone of book.zones) {
    if (!/^[a-z0-9_-]{1,60}$/.test(zone.id) || ids.has(zone.id) || typeof zone.name !== "string" || !zone.name.trim() || zone.name.length > 100 || !Array.isArray(zone.countries) || !Array.isArray(zone.methods) || zone.methods.length > 20 || typeof zone.worldwide !== "boolean") fail("shipping_zone_invalid", "Each zone needs a unique identifier, name and destination membership.");
    ids.add(zone.id);
    if (zone.worldwide && (++worldwide > 1 || zone.countries.length)) fail("shipping_destination_overlap", "Only one Worldwide zone is allowed and it cannot assign specific countries.");
    for (const country of zone.countries) {
      if (!countries.has(country)) fail("shipping_destination_invalid", `Unsupported country code: ${country}.`);
      if (assigned.has(country)) fail("shipping_destination_overlap", `${country} belongs to more than one specific zone.`);
      assigned.add(country);
    }
    const methods = new Set();
    for (const method of zone.methods) {
      if (!/^[a-z0-9_-]{1,60}$/.test(method.id) || methods.has(method.id) || typeof method.name !== "string" || !method.name.trim() || method.name.length > 100 || /[<>\u0000-\u001f]/.test(method.name) || !["enabled", "disabled", "archived"].includes(method.status) || method.providerServiceId !== "STANDARD") fail("shipping_method_invalid", "Methods require unique identifiers, checkout names and the Standard fulfillment service.");
      methods.add(method.id);
      if (method.estimatedDelivery !== null && (typeof method.estimatedDelivery !== "string" || method.estimatedDelivery.length > 240)) fail("shipping_estimate_invalid", "Delivery text must be blank or at most 240 characters.");
      if (method.freeShippingSubtotal !== null && !integer(method.freeShippingSubtotal, 1)) fail("shipping_threshold_invalid", "Free shipping requires a positive CAD-cent merchandise subtotal threshold.");
      if (!Array.isArray(method.bands) || !method.bands.length || method.bands.length > 50) fail("shipping_bands_invalid", "Provide between one and fifty weight ranges.");
      let boundary = 0;
      method.bands.forEach((band, index) => {
        if (!integer(band.lowerMg) || band.lowerMg !== boundary || !integer(band.amount) || (band.upperMg === null ? index !== method.bands.length - 1 : !integer(band.upperMg, 1) || band.upperMg <= band.lowerMg)) fail("shipping_bands_invalid", "Ranges must start at zero, ascend without overlaps or internal gaps, and use an unlimited upper limit only on the last range. A finite final maximum is valid.");
        boundary = band.upperMg;
      });
    }
  }
  return book;
}

export function calculateMerchantRates(book, country, weightMg, subtotalAmount = 0) {
  if (!integer(weightMg, 1)) fail("shipping_weight_invalid", "Physical shipping requires a known positive cart weight.");
  if (!integer(subtotalAmount)) fail("shipping_subtotal_invalid", "The merchandise subtotal must be exact CAD cents.");
  if (book.exclusions.includes(country)) fail("shipping_destination_excluded", "Shipping is excluded for this destination.");
  const zone = book.zones.find(z => !z.worldwide && z.countries.includes(country)) || book.zones.find(z => z.worldwide);
  if (!zone) fail("shipping_zone_unavailable", "No shipping zone covers this destination.");
  const options = zone.methods.filter(m => m.status === "enabled").flatMap(method => {
    const bracketIndex = method.bands.findIndex(b => weightMg > b.lowerMg && (b.upperMg === null || weightMg <= b.upperMg));
    if (bracketIndex < 0) return [];
    const bracket = method.bands[bracketIndex];
    return [{ zoneId: zone.id, zoneName: zone.name, methodId: method.id, name: method.name, providerServiceId: method.providerServiceId, bracketIndex, bracket, weightMg, amount: method.freeShippingSubtotal !== null && subtotalAmount >= method.freeShippingSubtotal ? 0 : bracket.amount, estimatedDelivery: method.estimatedDelivery }];
  });
  if (!options.length) fail(zone.methods.some(m => m.status === "enabled") ? "shipping_weight_out_of_range" : "shipping_method_unavailable", `The configured shipping methods for ${zone.name} do not cover this cart weight or are unavailable. Adjust your cart or contact us for help. This does not mean the fulfillment provider cannot ship it.`);
  return options;
}

export async function activeRatebook(db) {
  return db.prepare("SELECT r.* FROM commerce_shipping_ratebooks r JOIN commerce_shipping_policy p ON p.active_ratebook_id=r.id WHERE p.id='primary'").first();
}
export async function cartShippingWeight(db, lines) {
  const physical = lines.filter(l => l.requiresShipping);
  if (!physical.length) return { totalMg: 0, sources: [] };
  const rows = (await db.prepare("SELECT * FROM commerce_shipping_weights WHERE product_id IN (" + physical.map(() => "?").join(",") + ") ORDER BY id").bind(...physical.map(l => l.productId)).all()).results || [];
  const sources = physical.map(line => {
    const override = rows.find(r => r.variant_id === line.variantId && r.weight_mg !== null);
    const weight = override || rows.find(r => r.product_id === line.productId && r.variant_id === null && r.weight_mg !== null);
    if (!weight || !integer(Number(weight.weight_mg), 1)) fail("shipping_item_weight_missing", `Shipping weight is missing or invalid for ${line.productName} (${line.variantId || line.productId}). Please contact us so we can configure this item.`);
    return { productId: line.productId, variantId: line.variantId, quantity: line.quantity, weightMg: Number(weight.weight_mg), sourceId: weight.id, revision: Number(weight.revision), provenance: weight.provenance };
  });
  const totalMg = sources.reduce((sum, s) => sum + s.weightMg * s.quantity, 0);
  if (!integer(totalMg, 1)) fail("shipping_weight_invalid", "The cart weight is outside the supported calculation range.");
  return { totalMg, sources };
}
export async function merchantCartRates(db, lines, country, subtotal) {
  const active = await activeRatebook(db);
  if (!active) fail("shipping_ratebook_unpublished", "Merchant shipping rates have not been published.");
  const weight = await cartShippingWeight(db, lines);
  return calculateMerchantRates(JSON.parse(active.body_json), country, weight.totalMg, subtotal).map(rate => ({ ...rate, policy: { ratebookId: active.id, revision: active.revision, weight, zoneId: rate.zoneId, methodId: rate.methodId, bracketIndex: rate.bracketIndex, bracket: rate.bracket } }));
}
export async function validateMerchantSelection(db, lines, country, selected, subtotal) {
  if (!await db.prepare("SELECT 1 FROM commerce_shipping_markets WHERE country_code=? AND status='active'").bind(country).first()) fail("shipping_destination_unavailable", "This shipping destination changed. Request a new quote.");
  const current = await merchantCartRates(db, lines, country, subtotal);
  if (!current.some(rate => rate.amount === selected.amount && JSON.stringify(rate.policy) === JSON.stringify(selected.merchantPolicy))) fail("shipping_quote_policy_changed", "Shipping rates or item weights changed. Request a new quote and review the updated total.");
}
export function merchantOrderGuards(db, selection) {
  const policy = selection.option.merchantPolicy;
  if (!policy) return [];
  return [transactionGuard(db, "EXISTS(SELECT 1 FROM commerce_shipping_policy p JOIN commerce_shipping_ratebooks r ON r.id=p.active_ratebook_id WHERE p.id='primary' AND r.id=? AND r.revision=?)", [policy.ratebookId, policy.revision]),
    transactionGuard(db, "EXISTS(SELECT 1 FROM commerce_settings WHERE setting_key='shipping_strategy' AND value_json='\"merchant_weight_bands\"') AND EXISTS(SELECT 1 FROM commerce_shipping_markets WHERE country_code=? AND status='active')", [selection.recipient.countryCode]),
    ...policy.weight.sources.flatMap(source => [
      transactionGuard(db, "EXISTS(SELECT 1 FROM commerce_shipping_weights WHERE id=? AND revision=? AND weight_mg=?)", [source.sourceId, source.revision, source.weightMg]),
      ...(source.sourceId.startsWith("product:") ? [transactionGuard(db, "NOT EXISTS(SELECT 1 FROM commerce_shipping_weights WHERE variant_id=? AND weight_mg IS NOT NULL)", [source.variantId])] : []),
    ])];
}

export async function shippingWeightCoverage(db) {
  const rows = (await db.prepare(`SELECT p.id productId,p.title productName,p.checkout_environment environment,v.id variantId,v.sku,v.size_label,v.color_label,
    COALESCE(vw.weight_mg,pw.weight_mg) weightMg,COALESCE(CASE WHEN vw.weight_mg IS NOT NULL THEN vw.provenance END,pw.provenance) provenance
    FROM commerce_products p JOIN commerce_product_variants v ON v.product_id=p.id
    LEFT JOIN commerce_shipping_weights pw ON pw.product_id=p.id AND pw.variant_id IS NULL
    LEFT JOIN commerce_shipping_weights vw ON vw.variant_id=v.id
    WHERE p.status='active' AND p.visibility='public' AND p.requires_shipping=1 AND p.provider_presence='current'
    AND v.provider_presence='current' AND v.status='active' AND v.visibility='public' AND v.is_sellable=1
    AND v.availability_status='active' AND v.fulfillment_provider='printful' AND v.fulfillment_mapping_status='mapped'
    ORDER BY p.title,v.id`).all()).results || [];
  return { total: rows.length, covered: rows.filter(r => r.weightMg > 0).length, missing: rows.filter(r => !(r.weightMg > 0)), rows };
}
export async function shippingManagerPayload(env) {
  const db = requireCommerceDb(env);
  const [policy, books, markets, coverage] = await Promise.all([
    db.prepare("SELECT * FROM commerce_shipping_policy WHERE id='primary'").first(),
    db.prepare("SELECT * FROM commerce_shipping_ratebooks WHERE status IN ('draft','published') ORDER BY created_at DESC").all(),
    db.prepare("SELECT country_code,display_name FROM commerce_shipping_markets WHERE status='active' ORDER BY display_name").all(), shippingWeightCoverage(db),
  ]);
  return { ok: true, policy, books: (books.results || []).map(r => ({ id: r.id, revision: r.revision, status: r.status, provenance: r.provenance, body: JSON.parse(r.body_json) })), markets: markets.results || [], coverage };
}
export async function mutateShippingRatebook(env, input) {
  const db = requireCommerceDb(env);
  const authorityBefore = input?.action === "publish" ? (await db.prepare(LAUNCH_AUTHORITY_SQL).first()).fingerprint : null;
  const current = await shippingManagerPayload(env);
  if (!input || !integer(input.revision, 1)) fail("shipping_revision_required", "Reload the current revision before saving.");
  const draft = current.books.find(b => b.status === "draft");
  if (!draft || draft.id !== input.ratebookId || draft.revision !== input.revision) fail("shipping_revision_conflict", "Shipping rates changed in another session. Reload before editing.");
  const body = validateRatebook(input.body, current.markets.map(m => m.country_code));
  const timestamp = nowIso();
  const statements = [transactionGuard(db, "EXISTS(SELECT 1 FROM commerce_shipping_ratebooks WHERE id=? AND revision=? AND status='draft')", [draft.id, input.revision])];
  if (input.action === "publish") {
    if (current.coverage.missing.length) fail("shipping_weights_incomplete", `${current.coverage.missing.length} checkout-eligible variants need real shipping weights before publication.`);
    if (!body.zones.some(z => z.methods.some(m => m.status === "enabled"))) fail("shipping_methods_unpublished", "At least one enabled shipping method is required.");
    statements.push(transactionGuard(db, `(${LAUNCH_AUTHORITY_SQL})=?`, [authorityBefore]));
    statements.push(db.prepare("UPDATE commerce_shipping_ratebooks SET status='archived' WHERE status='published'"));
    statements.push(db.prepare("UPDATE commerce_shipping_ratebooks SET body_json=?,revision=revision+1,status='published',updated_at=? WHERE id=?").bind(JSON.stringify(body), timestamp, draft.id));
    statements.push(db.prepare("UPDATE commerce_shipping_policy SET active_ratebook_id=?,revision=revision+1 WHERE id='primary'").bind(draft.id));
    statements.push(db.prepare("UPDATE commerce_settings SET value_json='\"merchant_weight_bands\"',updated_at=? WHERE setting_key='shipping_strategy'").bind(timestamp));
    statements.push(db.prepare("INSERT INTO commerce_shipping_ratebooks(id,revision,status,body_json,provenance,created_at,updated_at) VALUES(?,1,'draft',?,?,?,?)").bind(`shipping_${crypto.randomUUID()}`, JSON.stringify(body), "Copied from published " + draft.id, timestamp, timestamp));
  } else if (input.action === "save") statements.push(db.prepare("UPDATE commerce_shipping_ratebooks SET body_json=?,revision=revision+1,updated_at=? WHERE id=?").bind(JSON.stringify(body), timestamp, draft.id));
  else fail("shipping_action_invalid", "Choose save or publish.");
  try { await db.batch(statements); } catch (error) { if (String(error).includes("malformed JSON")) fail("shipping_revision_conflict", "Shipping authority changed. Reload and try again."); throw error; }
  return shippingManagerPayload(env);
}

export async function productShippingWeights(env, productId) {
  const db = requireCommerceDb(env);
  const product = await db.prepare("SELECT id,title FROM commerce_products WHERE id=?").bind(productId).first();
  if (!product) fail("shipping_product_unknown", "Product not found.");
  const weights = (await db.prepare("SELECT * FROM commerce_shipping_weights WHERE product_id=? ORDER BY id").bind(productId).all()).results || [];
  const variants = (await db.prepare("SELECT id,sku,size_label,color_label FROM commerce_product_variants WHERE product_id=? ORDER BY id").bind(productId).all()).results || [];
  return { ok: true, product, weights, variants };
}
export async function saveShippingWeights(env, productId, input) {
  const db = requireCommerceDb(env), existing = await productShippingWeights(env, productId);
  if (!Array.isArray(input?.assignments) || !input.assignments.length || input.assignments.length > 250) fail("shipping_weight_assignment_invalid", "Select between one and 250 explicit weight assignments.");
  const seen = new Set(), statements = [];
  for (const assignment of input.assignments) {
    const variantId = assignment.variantId ?? null, id = variantId ? `variant:${variantId}` : `product:${productId}`;
    if (seen.has(id) || (variantId && !existing.variants.some(v => v.id === variantId))) fail("shipping_weight_assignment_invalid", "Each assignment must identify a distinct variant of this product or its default.");
    seen.add(id);
    if (!integer(assignment.revision)) fail("shipping_revision_required", "The current weight revision is required.");
    const provenance = String(assignment.provenance || "").trim();
    if (!provenance || provenance.length > 500) fail("shipping_weight_provenance_required", "Record where this shipping weight came from (up to 500 characters).");
    const weight = assignment.value === null ? null : weightToMilligrams(assignment.value, assignment.unit);
    statements.push(transactionGuard(db, "COALESCE((SELECT revision FROM commerce_shipping_weights WHERE id=?),0)=?", [id, assignment.revision]));
    statements.push(db.prepare(`INSERT INTO commerce_shipping_weights(id,product_id,variant_id,weight_mg,provenance,revision,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET weight_mg=excluded.weight_mg,provenance=excluded.provenance,revision=commerce_shipping_weights.revision+1,updated_at=excluded.updated_at`).bind(id, productId, variantId, weight, provenance, nowIso()));
  }
  try { await db.batch(statements); } catch (error) { if (String(error).includes("malformed JSON")) fail("shipping_revision_conflict", "Weights changed in another session. Reload before saving."); throw error; }
  return productShippingWeights(env, productId);
}
