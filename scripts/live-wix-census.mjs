import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LIVE_WIX_SITE_ORIGIN,
  parsePublishedProductSitemap,
  parseSitemapIndex,
  projectLiveWixProduct,
} from "../functions/_shared/live-wix-census.js";

const USER_AGENT = "ThirdRailifyMigrationCensus/1.0 (+GET-only)";
const ROBOTS_URL = `${LIVE_WIX_SITE_ORIGIN}/robots.txt`;
const SITEMAP_INDEX_URL = `${LIVE_WIX_SITE_ORIGIN}/sitemap.xml`;
const PRODUCT_SITEMAP_URL = `${LIVE_WIX_SITE_ORIGIN}/store-products-sitemap.xml`;
const ACCESS_TOKENS_URL = `${LIVE_WIX_SITE_ORIGIN}/_api/v1/access-tokens`;
const STORES_APP_ID = "1380b703-ce81-ff05-f115-39571d94dfcd";
const OUTPUT_PATH = resolve("commerce-import/live/live-wix-published.snapshot.json");
const REQUEST_DELAY_MS = 250;

const PRODUCT_QUERY = `query getPublishedProduct($slug: String!) {
  catalog {
    product(slug: $slug, onlyVisible: true) {
      id name urlPart price formattedPrice currency isVisible isInStock sku productType
      options { title optionType selections { value description } }
      media { fullUrl }
      categories { id name }
      productItems(withDefaultVariant: true) {
        id sku price isVisible inventory { status quantity } optionsSelections
      }
    }
  }
}`;

const requests = [];
const robots = await getText(ROBOTS_URL);
if (!robots.includes(`Sitemap: ${SITEMAP_INDEX_URL}`)) throw new Error("robots.txt does not advertise the expected sitemap index.");
const sitemapIndex = await getText(SITEMAP_INDEX_URL);
const discoveredSitemaps = parseSitemapIndex(sitemapIndex);
if (!discoveredSitemaps.includes(PRODUCT_SITEMAP_URL)) throw new Error("The live Wix product sitemap was not discovered from the sitemap index.");
const productSitemap = await getText(PRODUCT_SITEMAP_URL);
const publishedEntries = parsePublishedProductSitemap(productSitemap);
if (!publishedEntries.length) throw new Error("No published Wix product pages were found.");

const accessTokens = await getJson(ACCESS_TOKENS_URL);
const anonymousStoresToken = accessTokens?.apps?.[STORES_APP_ID]?.accessToken;
if (!anonymousStoresToken) throw new Error("The anonymous public Wix Stores token is unavailable.");

const products = [];
for (const entry of publishedEntries) {
  await delay(REQUEST_DELAY_MS);
  const endpoint = new URL(`${LIVE_WIX_SITE_ORIGIN}/_api/wixstores-graphql-server/graphql`);
  endpoint.search = new URLSearchParams({
    query: PRODUCT_QUERY,
    variables: JSON.stringify({ slug: entry.slug }),
    operationName: "getPublishedProduct",
    source: "ThirdRailifyMigrationCensus",
  });
  const payload = await getJson(endpoint, { Authorization: anonymousStoresToken }, "public_product_by_slug");
  if (payload?.errors?.length) throw new Error(`Wix returned GraphQL errors for ${entry.slug}.`);
  products.push(projectLiveWixProduct(entry, payload?.data?.catalog?.product));
}

const snapshot = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  source: {
    siteOrigin: LIVE_WIX_SITE_ORIGIN,
    robotsUrl: ROBOTS_URL,
    sitemapIndexUrl: SITEMAP_INDEX_URL,
    productSitemapUrl: PRODUCT_SITEMAP_URL,
    discoveredSitemaps,
    evidenceMode: "PUBLIC_GET_ONLY",
    requestMethod: "GET",
    requestCount: requests.length,
    requestSummary: summarizeRequests(requests),
    anonymousTokenPersisted: false,
  },
  counts: {
    publishedProducts: products.length,
    physicalProductsRequiringReconciliation: products.filter((product) => product.classification === "PHYSICAL_PRODUCT_REQUIRES_RECONCILIATION").length,
    nonPhysicalProducts: products.filter((product) => product.classification !== "PHYSICAL_PRODUCT_REQUIRES_RECONCILIATION").length,
  },
  products: products.sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl)),
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: OUTPUT_PATH, ...snapshot.counts, requestCount: requests.length }, null, 2));

async function getText(url, headers = {}, purpose = purposeFor(url)) {
  const response = await requestGet(url, headers, purpose);
  return response.text();
}

async function getJson(url, headers = {}, purpose = purposeFor(url)) {
  const response = await requestGet(url, headers, purpose);
  return response.json();
}

async function requestGet(url, headers, purpose) {
  const parsed = new URL(url);
  if (parsed.origin !== LIVE_WIX_SITE_ORIGIN) throw new Error(`Refusing non-Wix census request: ${parsed.origin}`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    requests.push({ method: "GET", purpose, path: parsed.pathname, attempt });
    try {
      const response = await fetch(parsed, { method: "GET", redirect: "follow", headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/xml,text/plain;q=0.9,*/*;q=0.1", ...headers } });
      if (response.ok) return response;
      lastError = new Error(`GET ${parsed.pathname} returned ${response.status}.`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await delay(500 * attempt);
  }
  throw lastError;
}

function purposeFor(url) {
  const path = new URL(url).pathname;
  if (path === "/robots.txt") return "robots";
  if (path === "/sitemap.xml") return "sitemap_index";
  if (path === "/store-products-sitemap.xml") return "product_sitemap";
  if (path === "/_api/v1/access-tokens") return "anonymous_public_access_token";
  return "public_get";
}

function summarizeRequests(values) {
  const counts = new Map();
  for (const request of values) counts.set(request.purpose, (counts.get(request.purpose) || 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
