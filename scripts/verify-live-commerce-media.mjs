import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ADMIN_ORIGIN = String(process.env.THIRDRAILIFY_ADMIN_ORIGIN || "https://admin.thirdrailify.com").replace(/\/$/, "");
const PUBLIC_ORIGIN = String(process.env.THIRDRAILIFY_PUBLIC_ORIGIN || "https://thirdrailify.com").replace(/\/$/, "");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const resultsDirectory = join(tmpdir(), "thirdrailify-live-commerce-media");
await mkdir(resultsDirectory, { recursive: true });
const catalogue = await (await fetch(`${ADMIN_ORIGIN}/api/public/commerce/catalogue?verify=${Date.now()}`)).json();
const urls = catalogue.products.flatMap((product) => product.images || []);
if (catalogue.products.length !== 49 || urls.length !== 466 || urls.some((url) => !url.startsWith(`${ADMIN_ORIGIN}/commerce-media/`))) throw new Error("The live catalogue is not fully projected through first-party media.");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const assetPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const failedResponses = []; assetPage.on("response", (response) => { if (response.url().includes("/commerce-media/") && !response.ok()) failedResponses.push({ url: response.url(), status: response.status() }); });
  const dimensions = [];
  for (let offset = 0; offset < urls.length; offset += 40) {
    const batch = urls.slice(offset, offset + 40);
    await assetPage.setContent(batch.map((url) => `<img loading="eager" src="${url}">`).join(""), { waitUntil: "load", timeout: 120_000 });
    await assetPage.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 120_000 });
    dimensions.push(...await assetPage.locator("img").evaluateAll((images) => images.map((image) => ({ width: image.naturalWidth, height: image.naturalHeight }))));
  }
  if (failedResponses.length || dimensions.some((image) => image.width <= 0 || image.height <= 0)) throw new Error(`First-party asset browser load failed: ${JSON.stringify({ failedResponses, broken: dimensions.filter((image) => image.width <= 0 || image.height <= 0).length })}`);
  await assetPage.setContent(`<style>body{margin:0;padding:12px;background:#080807;display:grid;grid-template-columns:repeat(7,1fr);gap:8px}figure{margin:0;aspect-ratio:1;background:#111;border:1px solid #3d3513;overflow:hidden}img{width:100%;height:100%;object-fit:cover}</style>${catalogue.products.map((product) => `<figure><img loading="eager" src="${product.images[0]}" title="${escapeHtml(product.title)}"></figure>`).join("")}`, { waitUntil: "load", timeout: 120_000 });
  await assetPage.screenshot({ path: join(resultsDirectory, "all-49-primary-images.png"), fullPage: true });
  await assetPage.close();

  const viewports = [];
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addCookies([{ name: "thirdrailify_consent", value: encodeURIComponent(JSON.stringify({ version: 1, timestamp: new Date().toISOString(), expiry: new Date(Date.now() + 86400000).toISOString(), categories: { preferences: true, externalMedia: false } })), url: PUBLIC_ORIGIN, sameSite: "Lax" }]);
    const page = await context.newPage(); const consoleErrors = []; const wixRequests = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); }); page.on("pageerror", (error) => consoleErrors.push(error.message)); page.on("request", (request) => { if (request.url().includes("wixstatic.com")) wixRequests.push(request.url()); });
    await page.goto(`${PUBLIC_ORIGIN}/shop?media-proof=${Date.now()}`, { waitUntil: "networkidle", timeout: 60_000 }); await page.locator(".product-card").first().waitFor();
    for (let y = 0; y < await page.evaluate(() => document.body.scrollHeight); y += Math.max(300, height * .7)) { await page.evaluate((nextY) => scrollTo(0, nextY), y); await page.waitForTimeout(80); }
    await page.waitForFunction(() => [...document.querySelectorAll(".product-card__image img")].every((image) => image.complete), null, { timeout: 60_000 });
    const cards = await page.locator(".product-card__image img").evaluateAll((images) => images.map((image) => ({ src: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight })));
    const uniqueCardSources = new Set(cards.map((image) => image.src));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (cards.length < 49 || uniqueCardSources.size < 49 || cards.some((image) => !image.src.startsWith(`${ADMIN_ORIGIN}/commerce-media/`) || image.width <= 0 || image.height <= 0) || wixRequests.length || consoleErrors.length || overflow) throw new Error(`Live shop media acceptance failed at ${width}x${height}: ${JSON.stringify({ imageElements: cards.length, uniqueCardSources: uniqueCardSources.size, broken: cards.filter((image) => image.width <= 0).length, wixRequests: wixRequests.length, consoleErrors, overflow })}`);
    await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(resultsDirectory, `shop-${width}x${height}.png`), fullPage: false });
    viewports.push({ width, height, imageElements: cards.length, uniqueCardSources: uniqueCardSources.size, wixRequests: wixRequests.length, consoleErrors: consoleErrors.length, overflow }); await context.close();
  }
  process.stdout.write(`${JSON.stringify({ products: catalogue.products.length, imageReferences: urls.length, uniqueImages: new Set(urls).size, browserLoaded: dimensions.length, failedResponses: failedResponses.length, viewports, resultsDirectory }, null, 2)}\n`);
} finally { await browser.close(); }

function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
