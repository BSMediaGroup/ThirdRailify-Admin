const SITE_ORIGIN = "https://www.thirdrailify.com";
const PRODUCT_PATH_PREFIX = "/product-page/";

export function parseSitemapIndex(xml) {
  return xmlLocations(xml).filter((value) => value.endsWith("-sitemap.xml") || value.endsWith("/sitemap.xml"));
}

export function parsePublishedProductSitemap(xml) {
  const urls = [];
  const entries = String(xml || "").match(/<url>[\s\S]*?<\/url>/gi) || [];
  for (const entry of entries) {
    const location = decodeXml(firstTag(entry, "loc"));
    if (!isPublishedProductUrl(location)) continue;
    urls.push({
      canonicalUrl: location,
      slug: decodeURIComponent(new URL(location).pathname.slice(PRODUCT_PATH_PREFIX.length)),
      lastModified: decodeXml(firstTag(entry, "lastmod")) || null,
      sitemapImages: tagValues(entry, "image:loc").map(decodeXml),
    });
  }
  return urls.sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl));
}

export function projectLiveWixProduct(entry, product) {
  if (!product || !product.id || !product.name || product.urlPart !== entry.slug || product.isVisible !== true) {
    throw new Error(`Public Wix product evidence is incomplete for ${entry.slug}.`);
  }
  const productItems = array(product.productItems);
  const prices = productItems.map((item) => cadMinorUnits(item.price)).filter(Number.isSafeInteger);
  const displayedPrice = cadMinorUnits(product.price);
  const categories = array(product.categories).map((category) => String(category?.name || "").trim()).filter(Boolean);
  const options = array(product.options).map((option) => ({
    label: String(option?.title || "").trim(),
    type: String(option?.optionType || "").trim() || null,
    values: array(option?.selections).map((selection) => String(selection?.description || selection?.value || "").trim()).filter(Boolean),
  })).filter((option) => option.label);
  return {
    id: String(product.id),
    wixExternalProductId: String(product.id),
    title: String(product.name),
    slug: entry.slug,
    canonicalUrl: entry.canonicalUrl,
    publicUrl: entry.canonicalUrl,
    lastModified: entry.lastModified,
    listingState: "published",
    availability: product.isInStock ? "in_stock" : "out_of_stock",
    isInStock: Boolean(product.isInStock),
    currency: String(product.currency || "").toUpperCase(),
    visibleUnitAmountCad: displayedPrice,
    variantUnitAmountsCad: [...new Set(prices)].sort((left, right) => left - right),
    formattedPrice: String(product.formattedPrice || "") || null,
    optionLabels: options.map((option) => option.label),
    options,
    skus: productItems.map((item) => String(item?.sku || "").trim()).filter(Boolean),
    wixExternalVariantIds: productItems.map((item) => String(item?.id || "").trim()).filter(Boolean),
    variants: productItems.map((item) => ({
      id: String(item.id),
      sku: String(item.sku || "").trim() || null,
      unitAmountCad: cadMinorUnits(item.price),
      visible: item.isVisible === true,
      availability: String(item.inventory?.status || "unknown"),
      optionSelectionIndexes: array(item.optionsSelections),
    })),
    image: String(product.media?.[0]?.fullUrl || entry.sitemapImages[0] || "") || null,
    images: array(product.media).map((item) => String(item?.fullUrl || "")).filter(Boolean),
    categories,
    wixProductType: String(product.productType || "").toLowerCase() || null,
    classification: classifyPublicProduct(product, categories),
  };
}

export function classifyPublicProduct(product, categories = []) {
  const text = `${product?.name || ""} ${categories.join(" ")}`.toLowerCase();
  if (/gift\s*card/.test(text)) return "GIFT_CARD";
  if (/donat|support/.test(text)) return "DONATION";
  if (/\bvip\b|member(ship)?/.test(text)) return "VIP_MEMBERSHIP";
  if (String(product?.productType || "").toLowerCase() === "physical") return "PHYSICAL_PRODUCT_REQUIRES_RECONCILIATION";
  return "OTHER";
}

export function cadMinorUnits(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const minor = Math.round(number * 100);
  return Math.abs(number * 100 - minor) < 1e-7 && Number.isSafeInteger(minor) ? minor : null;
}

function isPublishedProductUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === SITE_ORIGIN && url.pathname.startsWith(PRODUCT_PATH_PREFIX) && url.pathname.length > PRODUCT_PATH_PREFIX.length && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function xmlLocations(xml) {
  return tagValues(xml, "loc").map(decodeXml);
}

function firstTag(xml, tag) {
  return tagValues(xml, tag)[0] || "";
}

function tagValues(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...String(xml || "").matchAll(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, "gi"))].map((match) => match[1].trim());
}

function decodeXml(value) {
  return String(value || "").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

export const LIVE_WIX_SITE_ORIGIN = SITE_ORIGIN;
