import { AuthFailure, cleanText, hmacSha256, normalizeOrigin, timingSafeEqual } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 8 * 1024;
const RANGE_HOURS = Object.freeze({ "24h": 24, "7d": 168, "30d": 720, "90d": 2160 });

export async function readAnalyticsBody(request) {
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new AuthFailure(415, "content_type_invalid", "A JSON analytics event is required.");
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new AuthFailure(413, "request_too_large", "The analytics event is too large.");
  const raw = await request.text();
  if (encoder.encode(raw).byteLength > MAX_BODY_BYTES) throw new AuthFailure(413, "request_too_large", "The analytics event is too large.");
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { throw new AuthFailure(400, "invalid_json", "The analytics event is invalid."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AuthFailure(400, "invalid_json", "The analytics event is invalid.");
  return { body, raw };
}

export async function verifyAnalyticsIngest(request, env, raw) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const expectedOrigin = normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN);
  const secret = String(env?.THIRDRAILIFY_ANALYTICS_INGEST_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!origin || origin !== expectedOrigin) throw new AuthFailure(403, "origin_not_allowed", "This analytics request origin is not allowed.");
  if (!secret || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new AuthFailure(401, "analytics_signature_invalid", "The analytics request could not be verified.");
  const digest = await digestHex(encoder.encode(raw));
  const pathname = new URL(request.url).pathname;
  const expected = await hmacSha256(secret, `${timestamp}\n${request.method}\n${pathname}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "analytics_signature_invalid", "The analytics request could not be verified.");
}

export async function ingestAnalyticsEvent(env, input) {
  assertOnlyFields(input, new Set(["id","eventType","occurredAt","sessionId","path","pageType","referrerHost","sourceCategory","countryCode","countryName","regionCode","regionName","city","latitude","longitude","deviceClass","browserFamily","platformFamily","visitorClass","metadata"]));
  const event = normalizeEvent(input);
  const result = await requireCommerceDb(env).prepare(`INSERT OR IGNORE INTO analytics_events
    (id,event_type,occurred_at,session_id,public_path,page_type,referrer_host,source_category,country_code,country_name,region_code,region_name,city,latitude,longitude,device_class,browser_family,platform_family,visitor_class,safe_metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      event.id,event.eventType,event.occurredAt,event.sessionId,event.path,event.pageType,event.referrerHost,event.sourceCategory,
      event.countryCode,event.countryName,event.regionCode,event.regionName,event.city,event.latitude,event.longitude,event.deviceClass,
      event.browserFamily,event.platformFamily,event.visitorClass,JSON.stringify(event.metadata),event.occurredAt,
    ).run();
  return { ok: true, accepted: Number(result?.meta?.changes || 0) === 1 };
}

export async function analyticsReport(env, rangeValue, nowValue = new Date()) {
  const db = requireCommerceDb(env);
  const range = Object.hasOwn(RANGE_HOURS, rangeValue) ? rangeValue : "7d";
  const now = validDate(nowValue);
  const hours = RANGE_HOURS[range];
  const starts = periodStarts(now);
  const selectedStart = iso(new Date(now.valueOf() - hours * 3_600_000));
  const bucket = range === "24h" ? "hour" : "day";
  const coveragePromise = db.prepare("SELECT MIN(occurred_at) coverage_start,MAX(occurred_at) coverage_end,COUNT(*) total FROM analytics_events").first();
  const totalsPromise = db.prepare(`SELECT
    SUM(CASE WHEN occurred_at>=? THEN 1 ELSE 0 END) views_24,
    COUNT(DISTINCT CASE WHEN occurred_at>=? THEN session_id END) sessions_24,
    SUM(CASE WHEN occurred_at>=? AND occurred_at<? THEN 1 ELSE 0 END) previous_views_24,
    COUNT(DISTINCT CASE WHEN occurred_at>=? AND occurred_at<? THEN session_id END) previous_sessions_24,
    SUM(CASE WHEN occurred_at>=? THEN 1 ELSE 0 END) views_7,
    COUNT(DISTINCT CASE WHEN occurred_at>=? THEN session_id END) sessions_7,
    SUM(CASE WHEN occurred_at>=? AND occurred_at<? THEN 1 ELSE 0 END) previous_views_7,
    COUNT(DISTINCT CASE WHEN occurred_at>=? AND occurred_at<? THEN session_id END) previous_sessions_7,
    SUM(CASE WHEN occurred_at>=? THEN 1 ELSE 0 END) views_30,
    COUNT(DISTINCT CASE WHEN occurred_at>=? THEN session_id END) sessions_30,
    SUM(CASE WHEN occurred_at>=? AND occurred_at<? THEN 1 ELSE 0 END) previous_views_30,
    COUNT(DISTINCT CASE WHEN occurred_at>=? AND occurred_at<? THEN session_id END) previous_sessions_30,
    SUM(CASE WHEN occurred_at>=? THEN 1 ELSE 0 END) views_90,
    COUNT(DISTINCT CASE WHEN occurred_at>=? THEN session_id END) sessions_90,
    SUM(CASE WHEN occurred_at>=? AND occurred_at<? THEN 1 ELSE 0 END) previous_views_90,
    COUNT(DISTINCT CASE WHEN occurred_at>=? AND occurred_at<? THEN session_id END) previous_sessions_90
    FROM analytics_events WHERE occurred_at>=? AND occurred_at<?`).bind(
      starts.current24,starts.current24,starts.previous24,starts.current24,starts.previous24,starts.current24,
      starts.current7,starts.current7,starts.previous7,starts.current7,starts.previous7,starts.current7,
      starts.current30,starts.current30,starts.previous30,starts.current30,starts.previous30,starts.current30,
      starts.current90,starts.current90,starts.previous90,starts.current90,starts.previous90,starts.current90,
      starts.previous90,iso(now),
    ).first();
  const [coverage, totals, series, pages, sources, devices, geo, revenue] = await Promise.all([
    coveragePromise, totalsPromise,
    db.prepare(`SELECT ${bucket === "hour" ? "substr(occurred_at,1,13) || ':00:00.000Z'" : "substr(occurred_at,1,10) || 'T00:00:00.000Z'"} bucket,COUNT(*) views,COUNT(DISTINCT session_id) sessions FROM analytics_events WHERE occurred_at>=? AND occurred_at<? GROUP BY bucket ORDER BY bucket`).bind(selectedStart,iso(now)).all(),
    db.prepare("SELECT public_path path,COUNT(*) views,COUNT(DISTINCT session_id) sessions,MAX(occurred_at) latest_at FROM analytics_events WHERE occurred_at>=? AND occurred_at<? GROUP BY public_path ORDER BY views DESC,path ASC LIMIT 12").bind(selectedStart,iso(now)).all(),
    db.prepare("SELECT source_category source,COUNT(*) views,COUNT(DISTINCT session_id) sessions FROM analytics_events WHERE occurred_at>=? AND occurred_at<? GROUP BY source_category ORDER BY views DESC,source ASC LIMIT 10").bind(selectedStart,iso(now)).all(),
    db.prepare("SELECT device_class device,COUNT(*) views,COUNT(DISTINCT session_id) sessions FROM analytics_events WHERE occurred_at>=? AND occurred_at<? GROUP BY device_class ORDER BY views DESC,device ASC").bind(selectedStart,iso(now)).all(),
    db.prepare(`SELECT country_code,country_name,region_name,city,latitude,longitude,COUNT(*) views,COUNT(DISTINCT session_id) sessions,MAX(occurred_at) latest_at,
      (SELECT e2.public_path FROM analytics_events e2 WHERE e2.country_code IS e.country_code AND e2.region_name IS e.region_name AND e2.city IS e.city AND e2.occurred_at>=? AND e2.occurred_at<? GROUP BY e2.public_path ORDER BY COUNT(*) DESC,e2.public_path LIMIT 1) top_path,
      (SELECT e3.source_category FROM analytics_events e3 WHERE e3.country_code IS e.country_code AND e3.region_name IS e.region_name AND e3.city IS e.city AND e3.occurred_at>=? AND e3.occurred_at<? GROUP BY e3.source_category ORDER BY COUNT(*) DESC,e3.source_category LIMIT 1) top_source,
      SUM(CASE WHEN visitor_class='member' THEN 1 ELSE 0 END) member_views
      FROM analytics_events e WHERE occurred_at>=? AND occurred_at<? AND latitude IS NOT NULL AND longitude IS NOT NULL
      GROUP BY country_code,country_name,region_name,city,latitude,longitude ORDER BY views DESC LIMIT 250`).bind(selectedStart,iso(now),selectedStart,iso(now),selectedStart,iso(now)).all(),
    revenuePulse(db, starts, now),
  ]);
  const coverageStart = cleanText(coverage?.coverage_start, 80) || null;
  const windows = reportWindows(totals || {}, coverageStart, starts);
  return {
    ok: true, range, generatedAt: iso(now), timezone: "UTC", configured: Boolean(env?.THIRDRAILIFY_ANALYTICS_INGEST_SECRET),
    coverage: { start: coverageStart, end: cleanText(coverage?.coverage_end, 80) || null, totalEvents: Number(coverage?.total || 0), lastIngestedAt: cleanText(coverage?.coverage_end, 80) || null },
    windows, selected: windows[range], bucket,
    series: rows(series).map((row) => ({ bucket: row.bucket, views: Number(row.views || 0), sessions: Number(row.sessions || 0) })),
    pages: rows(pages).map((row) => ({ path: row.path, views: Number(row.views || 0), sessions: Number(row.sessions || 0), latestAt: row.latest_at })),
    sources: rows(sources).map((row) => ({ source: row.source, views: Number(row.views || 0), sessions: Number(row.sessions || 0) })),
    devices: rows(devices).map((row) => ({ device: row.device, views: Number(row.views || 0), sessions: Number(row.sessions || 0) })),
    geography: rows(geo).map((row) => ({ countryCode: row.country_code, countryName: row.country_name, region: row.region_name, city: row.city, latitude: Number(row.latitude), longitude: Number(row.longitude), views: Number(row.views || 0), sessions: Number(row.sessions || 0), latestAt: row.latest_at, topPath: row.top_path, topSource: row.top_source, memberViews: Number(row.member_views || 0) })),
    revenue,
  };
}

async function revenuePulse(db, starts, now) {
  const orderRows = await db.prepare(`SELECT currency_code,
    SUM(CASE WHEN created_at>=? THEN customer_gross_amount ELSE 0 END) gross_24,SUM(CASE WHEN created_at>=? THEN refund_amount ELSE 0 END) refunds_24,
    SUM(CASE WHEN created_at>=? THEN customer_gross_amount ELSE 0 END) gross_7,SUM(CASE WHEN created_at>=? THEN refund_amount ELSE 0 END) refunds_7,
    SUM(CASE WHEN created_at>=? THEN customer_gross_amount ELSE 0 END) gross_30,SUM(CASE WHEN created_at>=? THEN refund_amount ELSE 0 END) refunds_30,
    SUM(CASE WHEN created_at>=? THEN customer_gross_amount ELSE 0 END) gross_90,SUM(CASE WHEN created_at>=? THEN refund_amount ELSE 0 END) refunds_90
    FROM commerce_orders WHERE environment='live' AND payment_status IN ('paid','partially_refunded','refunded') AND created_at<? GROUP BY currency_code`).bind(starts.current24,starts.current24,starts.current7,starts.current7,starts.current30,starts.current30,starts.current90,starts.current90,iso(now)).all();
  let donationRows = { results: [] };
  try { donationRows = await db.prepare(`SELECT currency_code,
    SUM(CASE WHEN created_at>=? THEN amount_minor ELSE 0 END) gross_24,SUM(CASE WHEN created_at>=? AND status IN ('refunded','reversed') THEN amount_minor ELSE 0 END) refunds_24,
    SUM(CASE WHEN created_at>=? THEN amount_minor ELSE 0 END) gross_7,SUM(CASE WHEN created_at>=? AND status IN ('refunded','reversed') THEN amount_minor ELSE 0 END) refunds_7,
    SUM(CASE WHEN created_at>=? THEN amount_minor ELSE 0 END) gross_30,SUM(CASE WHEN created_at>=? AND status IN ('refunded','reversed') THEN amount_minor ELSE 0 END) refunds_30,
    SUM(CASE WHEN created_at>=? THEN amount_minor ELSE 0 END) gross_90,SUM(CASE WHEN created_at>=? AND status IN ('refunded','reversed') THEN amount_minor ELSE 0 END) refunds_90
    FROM commerce_donations WHERE environment='live' AND status IN ('completed','refunded','reversed') AND created_at<? GROUP BY currency_code`).bind(starts.current24,starts.current24,starts.current7,starts.current7,starts.current30,starts.current30,starts.current90,starts.current90,iso(now)).all(); } catch { /* Donation migration may not be applied locally yet. */ }
  const currencies = new Map();
  for (const row of rows(orderRows)) currencies.set(row.currency_code, revenueCurrency(row.currency_code));
  for (const row of rows(donationRows)) if (!currencies.has(row.currency_code)) currencies.set(row.currency_code, revenueCurrency(row.currency_code));
  for (const row of rows(orderRows)) applyRevenue(currencies.get(row.currency_code), row, "merchandise");
  for (const row of rows(donationRows)) applyRevenue(currencies.get(row.currency_code), row, "donations");
  return { available: true, profitAvailable: false, profitUnavailableReason: "Authoritative processor fees and complete fulfilment costs are not available for every collected transaction.", currencies: [...currencies.values()] };
}

function revenueCurrency(currencyCode) { return { currencyCode, windows: Object.fromEntries(["24h","7d","30d","90d"].map((key) => [key,{ merchandise:0,donations:0,gross:0,refunded:0,net:0 }])) }; }
function applyRevenue(currency, row, kind) { for (const [key,suffix] of [["24h","24"],["7d","7"],["30d","30"],["90d","90"]]) { const gross=Number(row[`gross_${suffix}`]||0); const refunded=Number(row[`refunds_${suffix}`]||0); currency.windows[key][kind]+=gross; currency.windows[key].gross+=gross; currency.windows[key].refunded+=refunded; currency.windows[key].net+=gross-refunded; } }

function normalizeEvent(input) {
  if (input.eventType !== "page_view") throw new AuthFailure(400,"analytics_event_type_invalid","The analytics event type is not supported.");
  const occurredAt = iso(validDate(input.occurredAt));
  const latitude = nullableCoordinate(input.latitude,-90,90); const longitude = nullableCoordinate(input.longitude,-180,180);
  return { id: token(input.id,80), eventType:"page_view", occurredAt, sessionId:token(input.sessionId,80), path:normalizePublicPath(input.path), pageType:plain(input.pageType,48,"page"), referrerHost:host(input.referrerHost), sourceCategory:plain(input.sourceCategory,40,"direct"), countryCode:country(input.countryCode), countryName:nullablePlain(input.countryName,100), regionCode:nullablePlain(input.regionCode,24), regionName:nullablePlain(input.regionName,100), city:nullablePlain(input.city,100), latitude, longitude, deviceClass:new Set(["desktop","mobile","tablet","other"]).has(input.deviceClass)?input.deviceClass:"other", browserFamily:plain(input.browserFamily,32,"Other"), platformFamily:plain(input.platformFamily,32,"Other"), visitorClass:input.visitorClass==="member"?"member":"guest", metadata:safeMetadata(input.metadata) };
}

export function normalizePublicPath(value) { try { const url=new URL(String(value||"/"),"https://thirdrailify.invalid"); let path=url.pathname.replace(/\/{2,}/g,"/"); if (!path.startsWith("/")) path=`/${path}`; if (path.length>512 || /^\/(?:api|admin)(?:\/|$)/i.test(path) || /\.(?:js|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(path)) throw new Error("invalid"); return path || "/"; } catch { throw new AuthFailure(400,"analytics_path_invalid","The analytics path is invalid."); } }
export function periodStarts(nowValue) { const now=validDate(nowValue); const start=(hours)=>iso(new Date(now.valueOf()-hours*3_600_000)); return { current24:start(24),previous24:start(48),current7:start(168),previous7:start(336),current30:start(720),previous30:start(1440),current90:start(2160),previous90:start(4320) }; }
export function delta(current,previous,complete) { if (!complete) return { available:false,value:null,direction:"unavailable" }; if (previous===0) return current===0?{available:true,value:0,direction:"neutral"}:{available:true,value:null,direction:"new"}; const value=(current-previous)/previous; return { available:true,value,direction:value>0?"up":value<0?"down":"neutral" }; }
function reportWindows(row,coverageStart,starts) { const config=[["24h","24",starts.previous24],["7d","7",starts.previous7],["30d","30",starts.previous30],["90d","90",starts.previous90]]; return Object.fromEntries(config.map(([key,suffix,requiredStart])=>{ const views=Number(row[`views_${suffix}`]||0); const sessions=Number(row[`sessions_${suffix}`]||0); const previousViews=Number(row[`previous_views_${suffix}`]||0); const previousSessions=Number(row[`previous_sessions_${suffix}`]||0); const comparisonComplete=Boolean(coverageStart&&coverageStart<=requiredStart); return [key,{ views,sessions,pagesPerSession:sessions?views/sessions:null,comparisonComplete,previous:{views:previousViews,sessions:previousSessions,pagesPerSession:previousSessions?previousViews/previousSessions:null},deltas:{views:delta(views,previousViews,comparisonComplete),sessions:delta(sessions,previousSessions,comparisonComplete)} }]; })); }
function token(value,max) { const result=cleanText(value,max); if (!/^[A-Za-z0-9_-]{16,80}$/.test(result)) throw new AuthFailure(400,"analytics_identifier_invalid","The analytics identifier is invalid."); return result; }
function plain(value,max,fallback) { return nullablePlain(value,max)||fallback; }
function nullablePlain(value,max) { const result=cleanText(value,max); return result&&!/[<>\u0000-\u001f]/.test(result)?result:null; }
function country(value) { const result=String(value||"").trim().toUpperCase(); return /^[A-Z]{2}$/.test(result)?result:null; }
function host(value) { const result=String(value||"").trim().toLowerCase(); if (!result) return null; return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(result)?result:null; }
function nullableCoordinate(value,min,max) { if (value===null||value===undefined||value==="") return null; const number=Number(value); if (!Number.isFinite(number)||number<min||number>max) return null; return Math.round(number*10)/10; }
function safeMetadata(value) { if (!value||typeof value!=="object"||Array.isArray(value)) return {}; const allowed={}; if (typeof value.campaignSource==="string") allowed.campaignSource=plain(value.campaignSource,80,""); if (typeof value.campaignMedium==="string") allowed.campaignMedium=plain(value.campaignMedium,80,""); if (typeof value.campaignName==="string") allowed.campaignName=plain(value.campaignName,120,""); return Object.fromEntries(Object.entries(allowed).filter(([,entry])=>entry)); }
function assertOnlyFields(input,allowed) { if (Object.keys(input).some((key)=>!allowed.has(key))) throw new AuthFailure(400,"analytics_fields_invalid","The analytics event contains unsupported fields."); }
function validDate(value) { const date=value instanceof Date?value:new Date(String(value||"")); if (Number.isNaN(date.valueOf())) throw new AuthFailure(400,"analytics_timestamp_invalid","The analytics timestamp is invalid."); return date; }
function iso(value) { return value.toISOString(); }
function rows(result) { return result?.results||[]; }
async function digestHex(bytes) { const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)); return Array.from(digest,(byte)=>byte.toString(16).padStart(2,"0")).join(""); }

export { MAX_BODY_BYTES, RANGE_HOURS };
