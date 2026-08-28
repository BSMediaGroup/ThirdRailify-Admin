import { AuthFailure } from "./auth-core.js";

const DEFAULT_ORIGIN = "https://photon.komoot.io";
const MAX_RESULTS = 8;

export async function searchCoarseLocations(env, input, context = {}) {
  const query = clean(input?.query, 140);
  if (query.length < 2) return { ok: true, results: [] };
  const countryCode = country(input?.countryCode, true);
  const features = await photon(env, { q: query, limit: MAX_RESULTS }, context.fetchImpl);
  const seen = new Set();
  const results = [];
  for (const feature of features) {
    const item = coarseFeature(feature);
    if (!item || (countryCode && item.countryCode !== countryCode)) continue;
    const key = `${item.city.toLocaleLowerCase()}|${item.region.toLocaleLowerCase()}|${item.countryCode}`;
    if (seen.has(key)) continue;
    seen.add(key); results.push({ id: item.id, city: item.city, region: item.region, countryCode: item.countryCode, countryName: item.countryName, label: item.label });
    if (results.length >= MAX_RESULTS) break;
  }
  return { ok: true, results };
}

export async function resolveCoarseLocation(env, input, context = {}) {
  const city = required(input?.city, 100, "city_invalid", "Enter a valid city or locality.");
  const region = clean(input?.region, 100);
  const countryCode = country(input?.countryCode, false);
  const query = [city, region, countryCode].filter(Boolean).join(", ");
  const features = await photon(env, { q: query, limit: MAX_RESULTS, layer: "city" }, context.fetchImpl);
  const candidates = features.map(coarseFeature).filter(Boolean).filter((item) => item.countryCode === countryCode);
  const normalizedCity = fold(city);
  const normalizedRegion = fold(region);
  const best = candidates.find((item) => fold(item.city) === normalizedCity && (!normalizedRegion || fold(item.region).includes(normalizedRegion) || normalizedRegion.includes(fold(item.region))))
    || candidates.find((item) => fold(item.city) === normalizedCity)
    || candidates[0];
  if (!best || !Number.isFinite(best.latitude) || !Number.isFinite(best.longitude)) {
    throw new AuthFailure(422, "location_unresolved", "We could not resolve that location to a safe city-level point. Choose a suggestion or refine the city and region.");
  }
  return { city: best.city, region: best.region || region, countryCode: best.countryCode, latitude: roundCoarse(best.latitude), longitude: roundCoarse(best.longitude), label: best.label, provider: "photon-city" };
}

async function photon(env, params, fetchImpl = fetch) {
  const origin = geocoderOrigin(env);
  const url = new URL("/api/", origin);
  for (const [key, value] of Object.entries(params)) if (value !== "" && value != null) url.searchParams.set(key, String(value));
  url.searchParams.set("lang", "en");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response;
  try { response = await fetchImpl(url.toString(), { headers: { Accept: "application/json" }, signal: controller.signal }); }
  catch { throw new AuthFailure(503, "location_unavailable", "Location lookup is temporarily unavailable. Please try again."); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new AuthFailure(503, "location_unavailable", "Location lookup is temporarily unavailable. Please try again.");
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload?.features) ? payload.features.slice(0, MAX_RESULTS * 2) : [];
}

function coarseFeature(feature) {
  const properties = feature?.properties || {};
  const coordinates = feature?.geometry?.coordinates;
  const layer = clean(properties.type || properties.osm_value, 30).toLowerCase();
  const city = clean(properties.city || properties.locality || properties.district || properties.county || (new Set(["city", "town", "village", "municipality"]).has(layer) ? properties.name : ""), 100);
  const countryCode = country(properties.countrycode, true);
  if (!city || !countryCode) return null;
  const region = clean(properties.state || properties.county, 100);
  const countryName = clean(properties.country, 100) || countryCode;
  const longitude = Number(coordinates?.[0]); const latitude = Number(coordinates?.[1]);
  return { id: `${fold(city)}-${fold(region)}-${countryCode}`, city, region, countryCode, countryName, label: [city, region, countryName].filter(Boolean).join(", "), latitude, longitude };
}

function geocoderOrigin(env) {
  const value = clean(env?.GOATS_GEOCODER_ORIGIN, 240) || DEFAULT_ORIGIN;
  let url;
  try { url = new URL(value); } catch { throw new AuthFailure(503, "location_unavailable", "Location lookup is not configured."); }
  if (url.protocol !== "https:") throw new AuthFailure(503, "location_unavailable", "Location lookup is not configured.");
  return url.origin;
}
function country(value, optional) { const result = clean(value, 2).toUpperCase(); if (!result && optional) return ""; if (!/^[A-Z]{2}$/.test(result)) throw new AuthFailure(400, "country_invalid", "Choose a valid country."); return result; }
function required(value, max, code, message) { const result = clean(value, max); if (result.length < 2) throw new AuthFailure(400, code, message); return result; }
function clean(value, max) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max); }
function fold(value) { return clean(value, 120).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase(); }
function roundCoarse(value) { return Math.round(Number(value) * 100) / 100; }
