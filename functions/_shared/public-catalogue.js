import { AuthFailure, cleanText } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

export async function publicCataloguePayload(env) {
  const db = requireCommerceDb(env);
  const [{ products, collections }, checkoutEnabled] = await Promise.all([loadPublicCatalogue(db), publicCheckoutEnabled(db)]);
  return {
    ok: true,
    source: "commerce-d1",
    currency: "CAD",
    checkoutEnabled,
    collections,
    products,
    updatedAt: [...products, ...collections].reduce((latest, item) => !latest || item.updatedAt > latest ? item.updatedAt : latest, "") || null,
  };
}

export async function publicProductPayload(env, slug) {
  const normalizedSlug = cleanText(slug, 180).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
    throw new AuthFailure(404, "product_not_found", "The product was not found.");
  }
  const db = requireCommerceDb(env);
  const [{ products }, checkoutEnabled] = await Promise.all([loadPublicCatalogue(db, normalizedSlug), publicCheckoutEnabled(db)]);
  if (!products.length) throw new AuthFailure(404, "product_not_found", "The product was not found.");
  return { ok: true, source: "commerce-d1", currency: "CAD", checkoutEnabled, product: products[0] };
}

async function loadPublicCatalogue(db, slug = null) {
  const collectionResult = await db.prepare(
    `SELECT id, slug, title, description, display_order, updated_at
     FROM commerce_collections
     WHERE status = 'active' AND visibility = 'public'
     ORDER BY display_order, slug`,
  ).all();
  const collectionRows = collectionResult?.results || [];
  const productStatement = db.prepare(
    `SELECT id, slug, title, safe_metadata_json, is_featured, featured_order,
            unit_amount, currency_code, max_checkout_quantity, requires_shipping, updated_at
     FROM commerce_products
     WHERE status = 'active' AND visibility = 'public' ${slug ? "AND slug = ?" : ""}
     ORDER BY is_featured DESC, featured_order ASC, slug ASC`,
  );
  const productResult = await (slug ? productStatement.bind(slug) : productStatement).all();
  const rows = productResult?.results || [];
  if (!rows.length) return { products: [], collections: collectionRows.map((row) => serializePublicCollection(row, [])) };
  const ids = rows.map((row) => row.id);
  const [variantResult, membershipResult] = await Promise.all([db.prepare(
    `SELECT id, product_id, size_label, color_label, option_values_json,
            unit_amount, currency_code, availability_status, safe_metadata_json
     FROM commerce_product_variants
     WHERE product_id IN (${ids.map(() => "?").join(",")})
       AND status = 'active' AND visibility = 'public' AND is_ignored = 0
       AND is_sellable = 1 AND availability_status = 'active'
     ORDER BY product_id, local_variant_key, id`,
  ).bind(...ids).all(),
  db.prepare(`SELECT pc.product_id, c.id, c.slug, c.title
              FROM commerce_product_collections pc
              JOIN commerce_collections c ON c.id = pc.collection_id
              WHERE pc.product_id IN (${ids.map(() => "?").join(",")})
                AND c.status = 'active' AND c.visibility = 'public'
              ORDER BY pc.product_id, c.display_order, c.slug`).bind(...ids).all()]);
  const variantsByProduct = new Map(ids.map((id) => [id, []]));
  for (const row of variantResult?.results || []) variantsByProduct.get(row.product_id)?.push(serializePublicVariant(row));
  const collectionsByProduct = new Map(ids.map((id) => [id, []]));
  for (const row of membershipResult?.results || []) collectionsByProduct.get(row.product_id)?.push({ id: row.id, slug: row.slug, title: row.title });
  const products = rows.map((row) => serializePublicProduct(row, variantsByProduct.get(row.id) || [], collectionsByProduct.get(row.id) || [])).filter(Boolean);
  const publicProductIds = new Set(products.map((product) => product.id));
  const collectionProducts = new Map(collectionRows.map((row) => [row.id, []]));
  for (const row of membershipResult?.results || []) if (publicProductIds.has(row.product_id)) collectionProducts.get(row.id)?.push(row.product_id);
  return { products, collections: collectionRows.map((row) => serializePublicCollection(row, collectionProducts.get(row.id) || [])) };
}

function serializePublicProduct(row, variants, collections) {
  if (String(row.currency_code || "").toUpperCase() !== "CAD") return null;
  if (row.requires_shipping === 1 && variants.length === 0) return null;
  const metadata = safeObject(row.safe_metadata_json);
  const fallbackAmount = boundedAmount(row.unit_amount);
  const prices = variants.map((variant) => variant.unitAmount).filter(Number.isSafeInteger);
  if (!prices.length && fallbackAmount) prices.push(fallbackAmount);
  if (!prices.length) return null;
  const minUnitAmount = Math.min(...prices);
  const maxUnitAmount = Math.max(...prices);
  const primaryImage = safeHttpsUrl(metadata.publicImage);
  const additionalImages = safeStringArray(metadata.publicImages, 24, 4096).map(safeHttpsUrl).filter(Boolean);
  const images = [...new Set([primaryImage, ...additionalImages].filter(Boolean))];
  return {
    id: cleanText(row.id, 160),
    slug: cleanText(row.slug, 180),
    title: cleanText(row.title, 240),
    description: cleanText(metadata.description, 12000),
    images,
    categories: collections.map((collection) => cleanText(collection.title, 160)),
    collectionSlugs: collections.map((collection) => cleanText(collection.slug, 180)),
    tags: safeStringArray(metadata.tags, 30, 80),
    featured: row.is_featured === 1,
    featuredOrder: row.is_featured === 1 && Number.isSafeInteger(Number(row.featured_order)) ? Number(row.featured_order) : null,
    displayOrder: Number.isSafeInteger(Number(metadata.displayOrder)) ? Number(metadata.displayOrder) : 1000,
    requiresShipping: row.requires_shipping === 1,
    maxQuantity: boundedInteger(row.max_checkout_quantity, 1, 20, 20),
    price: {
      currency: "CAD",
      minUnitAmount,
      maxUnitAmount,
      label: priceLabel(minUnitAmount, maxUnitAmount),
    },
    variants,
    available: variants.length ? variants.some((variant) => variant.availability === "active") : true,
    updatedAt: cleanText(row.updated_at, 80),
  };
}

async function publicCheckoutEnabled(db) {
  const result = await db.prepare("SELECT setting_key,value_json FROM commerce_settings WHERE setting_key IN ('checkout_enabled','live_payment_capture_enabled','fulfillment_submission_enabled','commerce_emergency_paused')").all();
  const settings = Object.fromEntries((result?.results || []).map((row) => { try { return [row.setting_key, JSON.parse(row.value_json)]; } catch { return [row.setting_key, null]; } }));
  return settings.checkout_enabled === true && settings.live_payment_capture_enabled === true && settings.fulfillment_submission_enabled === true && settings.commerce_emergency_paused !== true;
}

function serializePublicCollection(row, productIds) {
  return {
    title: cleanText(row.title, 160), slug: cleanText(row.slug, 180), description: cleanText(row.description, 2000),
    displayOrder: boundedInteger(row.display_order, 0, 999999, 1000), productCount: productIds.length,
    productIds: [...productIds], updatedAt: cleanText(row.updated_at, 80),
  };
}

function serializePublicVariant(row) {
  const options = safeOptions(row.option_values_json);
  const metadata = safeObject(row.safe_metadata_json);
  const size = cleanText(row.size_label, 120) || null;
  const color = cleanText(row.color_label, 120) || null;
  const label = cleanText(metadata.displayLabel, 240) || [size, color].filter(Boolean).join(" / ") || Object.values(options).join(" / ") || "Standard";
  return {
    id: cleanText(row.id, 160),
    label,
    size,
    color,
    options,
    unitAmount: boundedAmount(row.unit_amount),
    currency: "CAD",
    availability: row.availability_status === "temporarily_out_of_stock" ? "temporarily_out_of_stock" : "active",
  };
}

function safeOptions(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).slice(0, 12).map(([key, item]) => [cleanText(key, 80), cleanText(item, 120)]).filter(([key, item]) => key && item));
  } catch { return {}; }
}

function safeObject(value) { try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }

function safeStringArray(value, maximum, itemLength) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((item) => cleanText(item, itemLength)).filter(Boolean))].slice(0, maximum);
  } catch { return []; }
}

function safeHttpsUrl(value) {
  const text = cleanText(value, 4096);
  if (!text) return null;
  try { const url = new URL(text); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function boundedAmount(value) { const amount = Number(value); return Number.isSafeInteger(amount) && amount >= 1 && amount <= 100_000_000 ? amount : null; }
function boundedInteger(value, minimum, maximum, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback; }
function priceLabel(minimum, maximum) { const formatted = (value) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(value / 100); return minimum === maximum ? formatted(minimum) : `From ${formatted(minimum)}`; }
