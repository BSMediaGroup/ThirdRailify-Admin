import { AuthFailure, nowIso } from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

const MODES = new Set(["static", "ticker", "crossfade"]);
const SPEEDS = new Set(["slow", "normal", "fast"]);
const LIVE_ANIMATIONS = new Set(["pulse", "sweep", "pulse-sweep", "static"]);
const INTENSITIES = new Set(["subtle", "normal", "strong"]);
const MESSAGE_LIMIT = 5;

export const DEFAULT_BANNER_CONFIG = Object.freeze({
  normal: { enabled: false, messages: [], mode: "static", speed: "normal" },
  live: { enabled: true, label: "LIVE NOW", showTitle: true, supportingText: null, ctaLabel: "WATCH NOW", animation: "pulse-sweep", intensity: "normal" },
});

export function normalizeBannerConfig(value) {
  if (!record(value) || !exactKeys(value, ["normal", "live"]) || !record(value.normal) || !record(value.live)) invalid("banner_config_invalid", "The banner configuration is malformed.");
  const normal = value.normal;
  const live = value.live;
  if (!exactKeys(normal, ["enabled", "messages", "mode", "speed"]) || typeof normal.enabled !== "boolean" || !Array.isArray(normal.messages) || normal.messages.length > MESSAGE_LIMIT || !MODES.has(normal.mode) || !SPEEDS.has(normal.speed)) invalid("banner_normal_invalid", "The normal banner settings are invalid.");
  const messages = normal.messages.map(normalizeMessage);
  if (normal.enabled && messages.length === 0) invalid("banner_message_required", "Add at least one message before enabling the normal banner.");
  if (!exactKeys(live, ["enabled", "label", "showTitle", "supportingText", "ctaLabel", "animation", "intensity"]) || typeof live.enabled !== "boolean" || typeof live.showTitle !== "boolean") invalid("banner_live_invalid", "The Live Now banner settings are invalid.");
  const label = requiredText(live.label, 32, "banner_live_label_invalid", "Use a live label of 32 characters or fewer.");
  const ctaLabel = requiredText(live.ctaLabel, 32, "banner_live_cta_invalid", "Use a Live Now action label of 32 characters or fewer.");
  const supportingText = live.supportingText === null ? null : requiredText(live.supportingText, 120, "banner_live_support_invalid", "Use supporting text of 120 characters or fewer.");
  if (!LIVE_ANIMATIONS.has(live.animation)) invalid("banner_live_animation_invalid", "Choose a supported Live Now animation.");
  if (!INTENSITIES.has(live.intensity)) invalid("banner_live_intensity_invalid", "Choose a supported Live Now intensity.");
  return {
    normal: { enabled: normal.enabled, messages, mode: normal.mode, speed: normal.speed },
    live: { enabled: live.enabled, label, showTitle: live.showTitle, supportingText, ctaLabel, animation: live.animation, intensity: live.intensity },
  };
}

export async function readBannerSettings(env) {
  const row = await requireCommerceDb(env).prepare("SELECT config_json, revision, updated_at FROM site_banner_settings WHERE id = 'global-banner'").first();
  if (!row) throw new AuthFailure(503, "banner_storage_unavailable", "Banner configuration storage is unavailable.");
  let parsed;
  try { parsed = JSON.parse(row.config_json); } catch { parsed = null; }
  return { config: normalizeBannerConfig(parsed), revision: Number(row.revision), updatedAt: row.updated_at };
}

export async function saveBannerSettings(env, value, expectedRevision, actorAccountId) {
  const config = normalizeBannerConfig(value);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) invalid("banner_revision_invalid", "Reload the banner configuration before saving.");
  const updatedAt = nowIso();
  const result = await requireCommerceDb(env).prepare(`UPDATE site_banner_settings
    SET config_json = ?, revision = revision + 1, updated_at = ?, updated_by_account_id = ?
    WHERE id = 'global-banner' AND revision = ?`).bind(JSON.stringify(config), updatedAt, actorAccountId, expectedRevision).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "banner_revision_conflict", "The banner changed in another session. Reload before saving.");
  return readBannerSettings(env);
}

export function publicBannerProjection(settings) {
  const config = settings.config;
  return {
    ok: true,
    schema: "thirdrailify-banner-v1",
    normal: config.normal,
    live: { ...config.live, ctaPath: "/watch/live" },
    updatedAt: settings.updatedAt,
  };
}

function normalizeMessage(value, index) {
  if (!record(value) || !exactKeys(value, ["text", "ctaLabel", "href", "newTab"]) || typeof value.newTab !== "boolean") invalid("banner_message_invalid", `Message ${index + 1} is malformed.`);
  const text = requiredText(value.text, 160, "banner_message_invalid", `Message ${index + 1} must contain no more than 160 characters.`);
  const ctaLabel = value.ctaLabel === null ? null : requiredText(value.ctaLabel, 40, "banner_cta_invalid", `Message ${index + 1} action label is invalid.`);
  const href = value.href === null ? null : safeHref(value.href);
  if (value.href !== null && !href) invalid("banner_link_invalid", `Message ${index + 1} link must be a safe internal route or HTTPS URL.`);
  if (Boolean(ctaLabel) !== Boolean(href)) invalid("banner_cta_invalid", `Message ${index + 1} needs both an action label and link.`);
  if (value.newTab && href?.startsWith("/")) invalid("banner_link_target_invalid", "Internal banner links must open in the same tab.");
  return { text, ctaLabel, href, newTab: value.newTab };
}

function safeHref(value) {
  if (typeof value !== "string" || value.length > 1024 || /[\r\n]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/api/")) return value;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}

function requiredText(value, maximum, code, message) {
  if (typeof value !== "string") invalid(code, message);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || [...cleaned].length > maximum) invalid(code, message);
  return cleaned;
}

function invalid(code, message) { throw new AuthFailure(400, code, message); }
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value, keys) { const expected = new Set(keys); return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key)); }
