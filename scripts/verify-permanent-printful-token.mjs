import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = { id: "18668025", name: "Third Railify API", type: "native" };
const SOURCE = { id: "16847493", name: "Third Railify Official", type: "wix" };

export async function verifyPermanentPrintfulTokens(values = loadServerValues(), fetchImpl = fetch) {
  const targetStores = await readPrintful(values.PRINTFUL_API_TOKEN, "https://api.printful.com/stores", fetchImpl);
  const scopePayload = await readPrintful(values.PRINTFUL_API_TOKEN, "https://api.printful.com/v2/oauth-scopes", fetchImpl);
  const target = normalizeSingleStore(targetStores);
  const scopeValues = Array.isArray(scopePayload?.data)
    ? scopePayload.data.map((item) => String(item?.value || "").trim().toLowerCase()).filter(Boolean).sort()
    : [];
  const hasManage = (name) => scopeValues.includes(name) || scopeValues.includes(`${name}/write`);
  const manageAuthority = {
    syncProducts: hasManage("sync_products") || hasManage("products"),
    files: hasManage("file_library") || hasManage("files"),
    orders: hasManage("orders"),
    webhooks: hasManage("webhooks"),
  };

  assertStore(target, TARGET, "Permanent target");
  const sourceCredential = typeof values.PRINTFUL_WIX_SOURCE_TOKEN === "string" && values.PRINTFUL_WIX_SOURCE_TOKEN.trim();
  const source = sourceCredential
    ? normalizeSingleStore(await readPrintful(sourceCredential, "https://api.printful.com/stores", fetchImpl))
    : SOURCE;
  if (sourceCredential) assertStore(source, SOURCE, "Legacy source");
  if (target.id === source.id) throw new Error("Legacy source and permanent target Store IDs collide.");
  if (!Object.values(manageAuthority).every(Boolean)) throw new Error("The permanent target token is missing an expected manage scope.");
  return { target, source, sourceIdentityBasis: sourceCredential ? "live_read_only" : "pinned_configuration", separated: true, scopeValues, manageAuthority };
}

async function readPrintful(token, url, fetchImpl) {
  if (typeof token !== "string" || !token.trim()) throw new Error("A required server-only Printful token is absent.");
  const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token.trim()}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Printful read-only verification failed with HTTP ${response.status}.`);
  return payload;
}

function normalizeSingleStore(payload) {
  if (payload?.code !== 200 || !Array.isArray(payload.result) || payload.result.length !== 1 || Number(payload?.paging?.total) !== 1) {
    throw new Error("A Printful token did not resolve exactly one store.");
  }
  const store = payload.result[0];
  return { id: String(store.id), name: String(store.name), type: String(store.type).toLowerCase() };
}

function assertStore(actual, expected, label) {
  if (actual.id !== expected.id || actual.name !== expected.name || actual.type !== expected.type) throw new Error(`${label} identity mismatch.`);
}

function loadServerValues() {
  const values = { ...process.env };
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([^#=]+)=(.*)$/.exec(line);
    if (!match || values[match[1].trim()]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1].trim()] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyPermanentPrintfulTokens(), null, 2));
}
