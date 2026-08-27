import {
  AuthFailure,
  cleanText,
  escapeHtml,
  hmacSha256,
  normalizeEmail,
  normalizeOrigin,
  nowIso,
  randomId,
  randomToken,
  timingSafeEqual,
  verifyTurnstile,
} from "./auth-core.js";
import { requireCommerceDb } from "./commerce-core.js";

export const GOATS_MEDIA_BINDING = "THIRDRAILIFY_PROFILE_MEDIA";
export const MAX_GOAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_GOAT_GALLERY_IMAGES = 5;
export const GOATS_DRAFT_TTL_SECONDS = 60 * 60 * 24;
export const GOATS_CONSENT_VERSION = "goats-v2-2026-08";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_SORTS = new Set(["newest", "most-liked", "highest-rated"]);
const ALLOWED_STATUSES = new Set(["pending", "approved", "rejected"]);
const encoder = new TextEncoder();

export async function publicCommunityConfig(env) {
  const settings = await requireCommerceDb(env)
    .prepare("SELECT setting_key, value_json FROM commerce_settings WHERE setting_key IN ('community_submission_enabled','community_geocoder_configured','community_consent_version')")
    .all();
  const values = Object.fromEntries((settings?.results || []).map((row) => [row.setting_key, parseJson(row.value_json, null)]));
  return {
    ok: true,
    submissionEnabled: values.community_submission_enabled === true,
    captchaConfigured: Boolean(env?.THIRDRAILIFY_TURNSTILE_SECRET_KEY),
    turnstileSiteKey: env?.THIRDRAILIFY_TURNSTILE_SECRET_KEY && env?.THIRDRAILIFY_TURNSTILE_SITE_KEY
      ? String(env.THIRDRAILIFY_TURNSTILE_SITE_KEY)
      : null,
    geocoderConfigured: values.community_geocoder_configured === true,
    consentVersion: typeof values.community_consent_version === "string" ? values.community_consent_version : GOATS_CONSENT_VERSION,
    limits: { maxImageBytes: MAX_GOAT_IMAGE_BYTES, maxGalleryImages: MAX_GOAT_GALLERY_IMAGES },
  };
}

export async function publicProducts(env) {
  const result = await requireCommerceDb(env).prepare(
    `SELECT id, slug, title, safe_metadata_json FROM commerce_products
     WHERE status = 'active' AND visibility = 'public' ORDER BY title COLLATE NOCASE ASC LIMIT 250`,
  ).all();
  return {
    ok: true,
    products: (result?.results || []).map((row) => {
      const metadata = parseJson(row.safe_metadata_json, {});
      return { id: row.id, slug: row.slug, name: row.title, image: safePublicUrl(metadata.image || metadata.image_url) };
    }),
  };
}

export async function publicListings(env, input = {}) {
  const db = requireCommerceDb(env);
  const page = boundedInteger(input.page, 1, 10_000, 1);
  const pageSize = boundedInteger(input.pageSize, 1, input.internalMap === true ? 1000 : 48, 12);
  const search = cleanText(input.search, 100);
  const product = cleanText(input.product, 160);
  const country = countryCode(input.country, true);
  const rating = input.rating === "" || input.rating == null ? null : boundedInteger(input.rating, 1, 5, null);
  const sort = ALLOWED_SORTS.has(input.sort) ? input.sort : "newest";
  const clauses = ["s.status = 'approved'", "s.is_published = 1"];
  const binds = [];
  if (search) { clauses.push("(s.display_name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR s.public_location_label LIKE ? ESCAPE '\\')"); const value = `%${escapeLike(search)}%`; binds.push(value, value, value); }
  if (product) { clauses.push("s.product_id = ?"); binds.push(product); }
  if (country) { clauses.push("s.country_code = ?"); binds.push(country); }
  if (rating) { clauses.push("s.rating >= ?"); binds.push(rating); }
  const where = clauses.join(" AND ");
  const order = sort === "most-liked"
    ? "like_count DESC, s.approved_at DESC"
    : sort === "highest-rated" ? "s.rating DESC, s.approved_at DESC" : "s.approved_at DESC";
  const base = publicSelect();
  const [rows, count, stats, countries] = await Promise.all([
    db.prepare(`${base} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, pageSize, (page - 1) * pageSize).all(),
    db.prepare(`SELECT COUNT(*) AS count FROM community_submissions s WHERE ${where}`).bind(...binds).first(),
    db.prepare(`SELECT COUNT(*) AS listings, COUNT(DISTINCT country_code) AS countries, COUNT(DISTINCT product_id) AS products FROM community_submissions WHERE status = 'approved' AND is_published = 1`).first(),
    db.prepare(`SELECT country_code AS code, COUNT(*) AS count FROM community_submissions WHERE status = 'approved' AND is_published = 1 GROUP BY country_code ORDER BY country_code ASC LIMIT 250`).all(),
  ]);
  return {
    ok: true,
    items: (rows?.results || []).map(publicListingProjection),
    page,
    pageSize,
    total: Number(count?.count || 0),
    stats: { listings: Number(stats?.listings || 0), countries: Number(stats?.countries || 0), products: Number(stats?.products || 0) },
    facets: { countries: (countries?.results || []).map((row) => ({ code: row.code, count: Number(row.count || 0) })) },
  };
}

export async function publicMapGeoJson(env, input = {}) {
  const galleryPageSize = boundedInteger(input.pageSize, 1, 48, 12);
  const payload = await publicListings(env, { ...input, page: 1, pageSize: 1000, internalMap: true });
  return {
    type: "FeatureCollection",
    features: payload.items.filter((item) => Number.isFinite(item.location.latitude) && Number.isFinite(item.location.longitude)).map((item, index) => ({
      type: "Feature",
      id: item.id,
      geometry: { type: "Point", coordinates: [item.location.longitude, item.location.latitude] },
      properties: {
        id: item.id,
        slug: item.slug,
        displayName: item.displayName,
        locationLabel: item.location.label,
        countryCode: item.location.countryCode,
        imageUrl: item.media.main?.url || null,
        product: item.product,
        rating: item.rating,
        excerpt: item.description.slice(0, 180),
        galleryPage: Math.floor(index / galleryPageSize) + 1,
      },
    })),
  };
}

export async function publicListingBySlug(env, slug, accountId = "") {
  const row = await requireCommerceDb(env).prepare(
    `${publicSelect()} WHERE s.public_slug = ? AND s.status = 'approved' AND s.is_published = 1 LIMIT 1`,
  ).bind(validSlug(slug)).first();
  if (!row) throw new AuthFailure(404, "goat_not_found", "This GOAT listing was not found.");
  const item = publicListingProjection(row);
  const media = await requireCommerceDb(env).prepare(
    "SELECT id, role, sort_order FROM community_media WHERE submission_id = ? AND processing_state = 'ready' ORDER BY CASE role WHEN 'main' THEN 0 WHEN 'profile' THEN 1 ELSE 2 END, sort_order",
  ).bind(item.id).all();
  const neighbours = await publicNeighbours(env, row.approved_at, row.id);
  let currentReaction = 0;
  if (accountId) {
    const reaction = await requireCommerceDb(env).prepare("SELECT value FROM community_reactions WHERE submission_id = ? AND account_id = ?").bind(item.id, cleanText(accountId, 160)).first();
    currentReaction = Number(reaction?.value || 0);
  }
  return {
    ok: true,
    item: {
      ...item,
      media: {
        main: mediaProjection((media?.results || []).find((entry) => entry.role === "main")),
        profile: mediaProjection((media?.results || []).find((entry) => entry.role === "profile")),
        gallery: (media?.results || []).filter((entry) => entry.role === "gallery").map(mediaProjection),
      },
      currentReaction,
      neighbours,
    },
  };
}

export async function publicComments(env, slug, input = {}) {
  const listing = await publicListingRowBySlug(env, slug);
  const page = boundedInteger(input.page, 1, 10_000, 1);
  const pageSize = boundedInteger(input.pageSize, 1, 50, 20);
  const direction = input.sort === "oldest" ? "ASC" : "DESC";
  const result = await requireCommerceDb(env).prepare(
    `SELECT id, account_id, author_display_name, author_avatar_url, body, created_at, updated_at
     FROM community_comments WHERE submission_id = ? AND status = 'visible'
     ORDER BY created_at ${direction} LIMIT ? OFFSET ?`,
  ).bind(listing.id, pageSize, (page - 1) * pageSize).all();
  const count = await requireCommerceDb(env).prepare("SELECT COUNT(*) AS count FROM community_comments WHERE submission_id = ? AND status = 'visible'").bind(listing.id).first();
  const accountId = cleanText(input.accountId, 160);
  return { ok: true, items: (result?.results || []).map((row) => ({ ...commentProjection(row), isOwn: Boolean(accountId && row.account_id === accountId) })), page, pageSize, total: Number(count?.count || 0) };
}

export async function createDraft(env, request, input, context = {}) {
  if (cleanText(input.website, 120)) throw new AuthFailure(400, "submission_invalid", "The submission could not be accepted.");
  await requireSubmissionEnabled(env);
  await enforceCommunityRateLimit(env, "draft", context.rateKey || "unknown", 5, 60 * 60);
  await verifyTurnstile(env, request, input.turnstileToken, "goat_submission", context.fetchImpl || fetch);
  const token = randomToken(32);
  const id = randomId();
  const timestamp = nowIso();
  const reference = `GOAT-${id.slice(0, 8).toUpperCase()}`;
  const expiresAt = new Date(Date.now() + GOATS_DRAFT_TTL_SECONDS * 1000).toISOString();
  await requireCommerceDb(env).prepare(
    `INSERT INTO community_submissions (id, reference_code, status, draft_token_hash, draft_expires_at, submitter_account_id, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`,
  ).bind(id, reference, await digestHex(token), expiresAt, cleanText(context.accountId, 160) || null, timestamp, timestamp).run();
  return { ok: true, draftToken: token, reference, expiresAt };
}

export async function uploadDraftMedia(env, draftToken, roleValue, sortValue, bytes, declaredType, context = {}) {
  const draft = await requireDraft(env, draftToken);
  await enforceCommunityRateLimit(env, "upload", context.rateKey || draft.id, 12, 60 * 60);
  const role = new Set(["main", "profile", "gallery"]).has(roleValue) ? roleValue : "";
  const sortOrder = role === "gallery" ? boundedInteger(sortValue, 0, MAX_GOAT_GALLERY_IMAGES - 1, null) : 0;
  if (!role || sortOrder == null) throw new AuthFailure(400, "media_role_invalid", "The image role is invalid.");
  const image = sanitizeImage(new Uint8Array(bytes), declaredType);
  const count = await requireCommerceDb(env).prepare("SELECT COUNT(*) AS count FROM community_media WHERE submission_id = ? AND role = ?").bind(draft.id, role).first();
  if (role !== "gallery" && Number(count?.count || 0) >= 1) throw new AuthFailure(409, "media_role_exists", "Replace the existing image before uploading another.");
  if (role === "gallery" && Number(count?.count || 0) >= MAX_GOAT_GALLERY_IMAGES) throw new AuthFailure(400, "gallery_limit", "Up to five gallery images are allowed.");
  const id = randomId();
  const contentHash = await digestBytesHex(image.bytes);
  const extension = image.contentType === "image/jpeg" ? "jpg" : image.contentType.split("/")[1];
  const objectKey = `goats/private/${draft.id}/${id}-${contentHash.slice(0, 16)}.${extension}`;
  const bucket = requireMediaBucket(env);
  await bucket.put(objectKey, image.bytes, {
    httpMetadata: { contentType: image.contentType, cacheControl: "private, no-store" },
    customMetadata: { kind: "goat-submission", schema: "thirdrailify-goats-media-v2" },
  });
  try {
    await requireCommerceDb(env).prepare(
      `INSERT INTO community_media (id, submission_id, role, sort_order, object_key, content_type, byte_size, width, height, sha256, processing_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
    ).bind(id, draft.id, role, sortOrder, objectKey, image.contentType, image.bytes.byteLength, image.width, image.height, contentHash, nowIso()).run();
  } catch (error) {
    if (typeof bucket.delete === "function") await bucket.delete(objectKey).catch(() => undefined);
    throw error;
  }
  return { ok: true, media: mediaProjection({ id, role, sort_order: sortOrder }) };
}

export async function finaliseDraft(env, draftToken, input, context = {}) {
  const draft = await requireDraft(env, draftToken);
  await enforceCommunityRateLimit(env, "finalise", context.rateKey || draft.id, 5, 60 * 60);
  const email = normalizeEmail(input.email);
  if (!email) throw new AuthFailure(400, "email_invalid", "Enter a valid email address.");
  const displayName = requiredText(input.displayName, 2, 80, "display_name_invalid");
  const description = requiredText(input.description, 20, 2000, "description_invalid");
  const city = requiredText(input.city, 2, 100, "city_invalid");
  const region = cleanText(input.region, 100);
  const country = countryCode(input.countryCode, false);
  const rating = input.rating == null || input.rating === "" ? null : boundedInteger(input.rating, 1, 5, null);
  if (input.rating != null && input.rating !== "" && rating == null) throw new AuthFailure(400, "rating_invalid", "Rating must be an integer from one through five.");
  if (input.consent !== true || input.consentVersion !== GOATS_CONSENT_VERSION) throw new AuthFailure(400, "consent_required", "Submission consent is required.");
  const product = await requirePublicProduct(env, input.productId);
  const main = await requireCommerceDb(env).prepare("SELECT id FROM community_media WHERE submission_id = ? AND role = 'main' AND processing_state = 'ready' LIMIT 1").bind(draft.id).first();
  if (!main) throw new AuthFailure(400, "main_image_required", "A validated main image is required.");
  const slug = await uniqueSlug(env, cleanText(input.slug, 120) || displayName);
  const timestamp = nowIso();
  const locationLabel = [city, region, country].filter(Boolean).join(", ");
  const variables = { display_name: displayName, submission_reference: draft.reference_code, product_name: product.title, submitted_date: timestamp, status: "pending", support_url: supportUrl(env) };
  const statements = [
    requireCommerceDb(env).prepare(
      `UPDATE community_submissions SET public_slug = ?, status = 'pending', draft_token_hash = NULL, draft_expires_at = NULL,
       submitter_email = ?, display_name = ?, description = ?, product_id = ?, product_slug_snapshot = ?, product_name_snapshot = ?, rating = ?,
       city = ?, region = ?, country_code = ?, public_location_label = ?, consent_version = ?, consented_at = ?, submitted_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND status = 'draft'`,
    ).bind(slug, email, displayName, description, product.id, product.slug, product.title, rating, city, region || null, country, locationLabel, GOATS_CONSENT_VERSION, timestamp, timestamp, timestamp, draft.id),
    moderationStatement(env, draft.id, null, "submitted", { productId: product.id, countryCode: country }, timestamp),
    outboxStatement(env, "goat_submission_received", email, draft.id, `submission-received:${draft.id}`, variables, timestamp),
  ];
  const adminRecipients = configuredAdminRecipients(env);
  for (const recipient of adminRecipients) {
    statements.push(outboxStatement(env, "goat_submission_admin_alert", recipient, draft.id, `submission-admin-alert:${draft.id}:${recipient}`, { ...variables, moderation_url: `${adminOrigin(env)}/goats/${draft.id}` }, timestamp));
  }
  const results = await requireCommerceDb(env).batch(statements);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "draft_finalised", "This draft has already been finalised.");
  return { ok: true, reference: draft.reference_code, status: "pending", emailQueued: true };
}

export async function mutateReaction(env, slug, accountId, value, context = {}) {
  const listing = await publicListingRowBySlug(env, slug);
  const actor = requiredText(accountId, 1, 160, "authentication_required");
  const reaction = Number(value);
  if (![-1, 1].includes(reaction)) throw new AuthFailure(400, "reaction_invalid", "Choose like or dislike.");
  await enforceCommunityRateLimit(env, "reaction", context.rateKey || actor, 60, 60 * 60);
  const db = requireCommerceDb(env);
  const current = await db.prepare("SELECT value FROM community_reactions WHERE submission_id = ? AND account_id = ?").bind(listing.id, actor).first();
  if (Number(current?.value || 0) === reaction) {
    await db.prepare("DELETE FROM community_reactions WHERE submission_id = ? AND account_id = ?").bind(listing.id, actor).run();
  } else {
    const timestamp = nowIso();
    await db.prepare(
      `INSERT INTO community_reactions (submission_id, account_id, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(submission_id, account_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(listing.id, actor, reaction, timestamp, timestamp).run();
  }
  const counts = await db.prepare("SELECT SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes, SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes FROM community_reactions WHERE submission_id = ?").bind(listing.id).first();
  return { ok: true, likes: Math.max(0, Number(counts?.likes || 0)), dislikes: Math.max(0, Number(counts?.dislikes || 0)), currentReaction: Number(current?.value || 0) === reaction ? 0 : reaction };
}

export async function createComment(env, slug, actor, bodyValue, context = {}) {
  const listing = await publicListingRowBySlug(env, slug);
  const accountId = requiredText(actor?.accountId, 1, 160, "authentication_required");
  const body = requiredText(bodyValue, 1, 1200, "comment_invalid");
  await enforceCommunityRateLimit(env, "comment", context.rateKey || accountId, 20, 60 * 60);
  const id = randomId();
  const timestamp = nowIso();
  await requireCommerceDb(env).prepare(
    `INSERT INTO community_comments (id, submission_id, account_id, author_display_name, author_avatar_url, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'visible', ?, ?)`,
  ).bind(id, listing.id, accountId, requiredText(actor?.displayName, 1, 80, "authentication_required"), safePublicUrl(actor?.avatarUrl), body, timestamp, timestamp).run();
  return { ok: true, item: commentProjection({ id, author_display_name: actor.displayName, author_avatar_url: safePublicUrl(actor.avatarUrl), body, created_at: timestamp, updated_at: timestamp }) };
}

export async function deleteComment(env, commentId, accountId) {
  const result = await requireCommerceDb(env).prepare(
    "UPDATE community_comments SET status = 'deleted', body = '[deleted]', deleted_at = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'visible'",
  ).bind(nowIso(), nowIso(), cleanText(commentId, 36), cleanText(accountId, 160)).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(404, "comment_not_found", "The comment was not found.");
  return { ok: true };
}

export async function mediaResponse(env, mediaId, request, options = {}) {
  const row = await requireCommerceDb(env).prepare(
    `SELECT m.*, s.status, s.is_published FROM community_media m
     JOIN community_submissions s ON s.id = m.submission_id WHERE m.id = ? LIMIT 1`,
  ).bind(cleanText(mediaId, 36)).first();
  if (!row || row.processing_state !== "ready" || (!options.admin && (row.status !== "approved" || Number(row.is_published) !== 1))) {
    throw new AuthFailure(404, "media_not_found", "The image was not found.");
  }
  const object = await requireMediaBucket(env).get(row.object_key);
  if (!object) throw new AuthFailure(404, "media_not_found", "The image was not found.");
  const headers = new Headers({
    "Cache-Control": options.admin ? "private, no-store" : "public, max-age=31536000, immutable",
    "Content-Type": row.content_type,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

export async function adminOverview(env) {
  const db = requireCommerceDb(env);
  const [counts, email, recent] = await Promise.all([
    db.prepare("SELECT status, is_published, COUNT(*) AS count FROM community_submissions WHERE status <> 'draft' GROUP BY status, is_published").all(),
    db.prepare("SELECT status, COUNT(*) AS count FROM community_email_outbox GROUP BY status").all(),
    db.prepare("SELECT id, reference_code, display_name, status, is_published, submitted_at, updated_at FROM community_submissions WHERE status <> 'draft' ORDER BY updated_at DESC LIMIT 8").all(),
  ]);
  const state = { pending: 0, approved: 0, rejected: 0, hidden: 0 };
  for (const row of counts?.results || []) {
    if (row.status === "approved" && Number(row.is_published) === 0) state.hidden += Number(row.count || 0);
    else state[row.status] = Number(row.count || 0);
  }
  return { ok: true, counts: state, email: Object.fromEntries((email?.results || []).map((row) => [row.status, Number(row.count || 0)])), recent: (recent?.results || []).map(adminSummary) };
}

export async function adminQueue(env, statusValue = "pending") {
  const status = ALLOWED_STATUSES.has(statusValue) ? statusValue : "pending";
  const result = await requireCommerceDb(env).prepare(
    `SELECT s.*,
       (SELECT COUNT(*) FROM community_media m WHERE m.submission_id = s.id) AS media_count,
       (SELECT id FROM community_media m WHERE m.submission_id = s.id AND m.role = 'main' ORDER BY m.created_at LIMIT 1) AS main_media_id,
       (SELECT status FROM community_email_outbox e WHERE e.submission_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS email_state
     FROM community_submissions s WHERE s.status = ? ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC LIMIT 200`,
  ).bind(status).all();
  return { ok: true, status, items: (result?.results || []).map(adminSummary) };
}

export async function adminSubmission(env, id) {
  const db = requireCommerceDb(env);
  const row = await db.prepare("SELECT * FROM community_submissions WHERE id = ? AND status <> 'draft' LIMIT 1").bind(cleanText(id, 36)).first();
  if (!row) throw new AuthFailure(404, "submission_not_found", "The submission was not found.");
  const [media, events, emails] = await Promise.all([
    db.prepare("SELECT id, role, sort_order, content_type, byte_size, width, height, processing_state, processing_error, created_at FROM community_media WHERE submission_id = ? ORDER BY role, sort_order").bind(row.id).all(),
    db.prepare("SELECT id, event_type, actor_account_id, metadata_json, created_at FROM community_moderation_events WHERE submission_id = ? ORDER BY created_at DESC").bind(row.id).all(),
    db.prepare("SELECT id, template_key, status, attempts, last_error, created_at, updated_at, sent_at FROM community_email_outbox WHERE submission_id = ? ORDER BY created_at DESC").bind(row.id).all(),
  ]);
  return { ok: true, item: adminProjection(row, media?.results || [], events?.results || [], emails?.results || []) };
}

export async function updateSubmission(env, id, expectedVersion, input, actorId) {
  const current = await requireVersion(env, id, expectedVersion);
  if (!new Set(["pending", "rejected"]).has(current.status)) throw new AuthFailure(409, "status_conflict", "This submission can no longer be edited.");
  const displayName = requiredText(input.displayName ?? current.display_name, 2, 80, "display_name_invalid");
  const city = requiredText(input.city ?? current.city, 2, 100, "city_invalid");
  const region = cleanText(input.region ?? current.region, 100);
  const country = countryCode(input.countryCode ?? current.country_code, false);
  const latitude = coordinate(input.latitude, -85, 85, true);
  const longitude = coordinate(input.longitude, -180, 180, true);
  const slug = await uniqueSlug(env, input.slug || current.public_slug || displayName, current.id);
  const timestamp = nowIso();
  const result = await requireCommerceDb(env).prepare(
    `UPDATE community_submissions SET display_name = ?, city = ?, region = ?, country_code = ?, public_location_label = ?,
     public_latitude = ?, public_longitude = ?, location_confirmed_at = ?, public_slug = ?, moderator_note = ?, moderator_account_id = ?,
     updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
  ).bind(displayName, city, region || null, country, [city, region, country].filter(Boolean).join(", "), latitude, longitude, latitude != null && longitude != null ? timestamp : null, slug, cleanText(input.moderatorNote, 2000) || null, actorId, timestamp, current.id, current.version).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "version_conflict", "This submission changed in another tab. Reload before saving.");
  const mediaStatements = await mediaUpdateStatements(env, current.id, input.mainMediaId, input.mediaOrder);
  await requireCommerceDb(env).batch([...mediaStatements, moderationStatement(env, current.id, actorId, "updated", { version: current.version + 1 }, timestamp)]);
  return adminSubmission(env, current.id);
}

export async function transitionSubmission(env, id, expectedVersion, action, input, actorId) {
  const current = await requireVersion(env, id, expectedVersion);
  const transition = allowedTransition(current, action);
  const timestamp = nowIso();
  if (action === "approve") await assertApprovable(env, current);
  const rejectionReason = action === "reject" ? requiredText(input.rejectionReason, 3, 500, "rejection_reason_required") : current.rejection_reason;
  const nextVersion = current.version + 1;
  const db = requireCommerceDb(env);
  const statements = [db.prepare(
    `UPDATE community_submissions SET status = ?, is_published = ?, approved_at = ?, rejected_at = ?, rejection_reason = ?, moderator_note = ?,
     moderator_account_id = ?, updated_at = ?, version = ? WHERE id = ? AND version = ?`,
  ).bind(transition.status, transition.published, action === "approve" ? timestamp : current.approved_at, action === "reject" ? timestamp : current.rejected_at, rejectionReason || null, cleanText(input.moderatorNote ?? current.moderator_note, 2000) || null, actorId, timestamp, nextVersion, current.id, current.version)];
  const variables = submissionVariables(env, { ...current, status: transition.status, rejection_reason: rejectionReason });
  statements.push(moderationStatement(env, current.id, actorId, transition.event, { version: nextVersion }, timestamp));
  if (action === "approve") statements.push(outboxStatement(env, "goat_submission_approved", current.submitter_email, current.id, `submission-approved:${current.id}`, variables, timestamp));
  if (action === "reject") statements.push(outboxStatement(env, "goat_submission_rejected", current.submitter_email, current.id, `submission-rejected:${current.id}:${nextVersion}`, variables, timestamp));
  const results = await db.batch(statements);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "version_conflict", "This submission changed in another tab. Reload before moderating.");
  return adminSubmission(env, current.id);
}

export async function moderateComment(env, commentId, visible, actorId) {
  const timestamp = nowIso();
  const status = visible ? "visible" : "hidden";
  const row = await requireCommerceDb(env).prepare("SELECT id, submission_id FROM community_comments WHERE id = ? AND status <> 'deleted'").bind(cleanText(commentId, 36)).first();
  if (!row) throw new AuthFailure(404, "comment_not_found", "The comment was not found.");
  await requireCommerceDb(env).batch([
    requireCommerceDb(env).prepare("UPDATE community_comments SET status = ?, moderated_by_account_id = ?, moderated_at = ?, updated_at = ? WHERE id = ?").bind(status, actorId, timestamp, timestamp, row.id),
    moderationStatement(env, row.submission_id, actorId, visible ? "comment_restored" : "comment_hidden", { commentId: row.id }, timestamp),
  ]);
  return { ok: true };
}

export async function adminComments(env, statusValue = "visible") {
  const status = statusValue === "hidden" ? "hidden" : "visible";
  const result = await requireCommerceDb(env).prepare(
    `SELECT c.id, c.submission_id, c.author_display_name, c.body, c.status, c.created_at, s.public_slug, s.display_name AS listing_name
     FROM community_comments c JOIN community_submissions s ON s.id = c.submission_id
     WHERE c.status = ? ORDER BY c.created_at DESC LIMIT 200`,
  ).bind(status).all();
  return { ok: true, status, items: (result?.results || []).map((row) => ({ id: row.id, submissionId: row.submission_id, listingSlug: row.public_slug, listingName: row.listing_name, displayName: row.author_display_name, body: row.body, status: row.status, createdAt: row.created_at })) };
}

export async function deleteDemoSubmission(env, id, expectedVersion, actorId) {
  const row = await requireVersion(env, id, expectedVersion);
  if (!String(row.reference_code || "").startsWith("DEMO-")) throw new AuthFailure(403, "demo_delete_forbidden", "Only explicitly seeded demo listings can be hard-deleted.");
  const media = await requireCommerceDb(env).prepare("SELECT object_key FROM community_media WHERE submission_id = ?").bind(row.id).all();
  const bucket = env?.[GOATS_MEDIA_BINDING];
  if ((media?.results || []).length && (!bucket || typeof bucket.delete !== "function")) throw new AuthFailure(503, "community_media_not_configured", "Demo media storage is not configured.");
  for (const item of media?.results || []) await bucket.delete(item.object_key);
  const result = await requireCommerceDb(env).prepare("DELETE FROM community_submissions WHERE id = ? AND version = ? AND reference_code LIKE 'DEMO-%'").bind(row.id, row.version).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(409, "version_conflict", "This demo listing changed in another tab. Reload before deleting.");
  return { ok: true, deletedId: row.id, actorAccountId: actorId };
}

export async function cleanupExpiredDrafts(env, actorId, limitValue = 50) {
  const db = requireCommerceDb(env);
  const limit = boundedInteger(limitValue, 1, 100, 50);
  const expired = await db.prepare(
    `SELECT s.id, m.object_key FROM community_submissions s
     LEFT JOIN community_media m ON m.submission_id = s.id
     WHERE s.status = 'draft' AND s.draft_expires_at < ?
     ORDER BY s.draft_expires_at ASC LIMIT ?`,
  ).bind(nowIso(), limit * (MAX_GOAT_GALLERY_IMAGES + 2)).all();
  const rows = expired?.results || [];
  const ids = [...new Set(rows.map((row) => row.id))].slice(0, limit);
  if (!ids.length) return { ok: true, deletedDrafts: 0, deletedObjects: 0, actorAccountId: actorId };
  const keys = [...new Set(rows.filter((row) => ids.includes(row.id) && row.object_key).map((row) => row.object_key))];
  if (keys.length) {
    const bucket = env?.[GOATS_MEDIA_BINDING];
    if (!bucket || typeof bucket.delete !== "function") throw new AuthFailure(503, "community_media_not_configured", "Draft media cleanup storage is not configured.");
    for (const key of keys) await bucket.delete(key);
  }
  let deletedDrafts = 0;
  for (const id of ids) {
    const result = await db.prepare("DELETE FROM community_submissions WHERE id = ? AND status = 'draft' AND draft_expires_at < ? RETURNING id").bind(id, nowIso()).all();
    deletedDrafts += Number(result?.results?.length || 0);
  }
  return { ok: true, deletedDrafts, deletedObjects: keys.length, actorAccountId: actorId };
}

export async function emailTemplates(env) {
  const result = await requireCommerceDb(env).prepare("SELECT * FROM community_email_templates ORDER BY template_key").all();
  return { ok: true, templates: (result?.results || []).map((row) => ({ templateKey: row.template_key, subject: row.subject, htmlBody: row.html_body, textBody: row.text_body, variables: parseJson(row.variables_json, []), status: row.status, revision: row.revision })) };
}

export async function updateEmailTemplate(env, key, input, actorId) {
  const subject = templateText(input.subject, 1, 200);
  const htmlBody = templateText(input.htmlBody, 1, 20_000, true);
  const textBody = templateText(input.textBody, 1, 10_000);
  if (/\r|\n/.test(subject)) throw new AuthFailure(400, "email_header_invalid", "The email subject cannot contain line breaks.");
  const result = await requireCommerceDb(env).prepare(
    "UPDATE community_email_templates SET subject = ?, html_body = ?, text_body = ?, status = ?, revision = revision + 1, updated_at = ?, updated_by_account_id = ? WHERE template_key = ?",
  ).bind(subject, htmlBody, textBody, new Set(["draft", "disabled", "ready"]).has(input.status) ? input.status : "draft", nowIso(), actorId, cleanText(key, 80)).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw new AuthFailure(404, "template_not_found", "The template was not found.");
  return emailTemplates(env);
}

export async function retryEmail(env, outboxId, actorId, fetchImpl = fetch) {
  const db = requireCommerceDb(env);
  const row = await db.prepare(
    `SELECT o.*, t.subject, t.html_body, t.text_body, t.status AS template_status
     FROM community_email_outbox o JOIN community_email_templates t ON t.template_key = o.template_key WHERE o.id = ? LIMIT 1`,
  ).bind(cleanText(outboxId, 36)).first();
  if (!row) throw new AuthFailure(404, "email_event_not_found", "The email event was not found.");
  if (row.status === "sent") return { ok: true, status: "sent", duplicate: true };
  if (row.template_status !== "ready") throw new AuthFailure(409, "email_template_not_ready", "The email template is not marked ready.");
  const apiKey = String(env?.RESEND_API_KEY || "");
  const from = cleanText(env?.MAIL_FROM, 254);
  if (!apiKey || !from) throw new AuthFailure(503, "email_not_configured", "Transactional email delivery is not configured.");
  const variables = parseJson(row.variables_json, {});
  const subject = renderTemplate(row.subject, variables, false);
  const html = brandedGoatEmailHtml(renderTemplate(row.html_body, variables, true), row.template_key, adminOrigin(env));
  const text = renderTemplate(row.text_body, variables, false);
  try {
    const response = await fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": row.idempotency_key }, body: JSON.stringify({ from, to: [row.recipient_email], subject, html, text, reply_to: normalizeEmail(env?.MAIL_REPLY_TO) || undefined }) });
    if (!response.ok) throw new Error(`provider_${response.status}`);
    const payload = await response.json().catch(() => ({}));
    await db.prepare("UPDATE community_email_outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL, provider_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ? AND status <> 'sent'").bind(cleanText(payload.id, 200) || null, nowIso(), nowIso(), row.id).run();
    await db.prepare("INSERT INTO community_moderation_events (id, submission_id, actor_account_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, 'email_retried', ?, ?)").bind(randomId(), row.submission_id, actorId, JSON.stringify({ outboxId: row.id, result: "sent" }), nowIso()).run();
    return { ok: true, status: "sent" };
  } catch (error) {
    await db.prepare("UPDATE community_email_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ? AND status <> 'sent'").bind(cleanText(error instanceof Error ? error.message : "delivery_failed", 300), nowIso(), row.id).run();
    throw new AuthFailure(503, "email_unavailable", "Transactional email delivery failed and remains retryable.");
  }
}

export async function dispatchReadyEmails(env, submissionId, actorId = null, fetchImpl = fetch) {
  const queued = await requireCommerceDb(env).prepare(
    `SELECT o.id FROM community_email_outbox o
     JOIN community_email_templates t ON t.template_key = o.template_key
     WHERE o.submission_id = ? AND o.status IN ('pending','failed') AND t.status = 'ready'
     ORDER BY o.created_at ASC LIMIT 10`,
  ).bind(cleanText(submissionId, 36)).all();
  const results = [];
  for (const row of queued?.results || []) {
    try { results.push(await retryEmail(env, row.id, actorId, fetchImpl)); }
    catch (error) { results.push({ ok: false, status: "failed", error: error?.code || "email_unavailable" }); }
  }
  return { ok: true, processed: results.length, results };
}

export async function verifyInternalRequest(request, env, rawBody) {
  const secret = String(env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  const timestamp = String(request.headers.get("x-thirdrailify-timestamp") || "");
  const signature = String(request.headers.get("x-thirdrailify-signature") || "");
  if (!secret || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new AuthFailure(401, "internal_signature_invalid", "The internal request could not be verified.");
  const url = new URL(request.url);
  const digest = await digestBytesHex(typeof rawBody === "string" ? encoder.encode(rawBody) : new Uint8Array(rawBody || []));
  const expected = await hmacSha256(secret, `${timestamp}\n${request.method}\n${url.pathname}\n${digest}`);
  if (!timingSafeEqual(expected, signature)) throw new AuthFailure(401, "internal_signature_invalid", "The internal request could not be verified.");
}

export function sanitizeImage(bytes, declaredType) {
  if (!bytes.byteLength) throw new AuthFailure(400, "image_empty", "The image is empty.");
  if (bytes.byteLength > MAX_GOAT_IMAGE_BYTES) throw new AuthFailure(413, "image_too_large", "Choose an image no larger than 10 MB.");
  const detected = detectImage(bytes);
  const declared = String(declaredType || "").split(";", 1)[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!detected || !ALLOWED_IMAGE_TYPES.has(declared) || declared !== detected.contentType) throw new AuthFailure(415, "image_format_invalid", "Upload a valid JPG, PNG, or WebP image.");
  const sanitized = detected.contentType === "image/jpeg" ? sanitizeJpeg(bytes) : detected.contentType === "image/png" ? sanitizePng(bytes) : sanitizeWebp(bytes);
  const next = detectImage(sanitized);
  if (!next || next.width > 12_000 || next.height > 12_000 || next.width * next.height > 50_000_000) throw new AuthFailure(415, "image_dimensions_invalid", "The image dimensions are unsupported.");
  return { bytes: sanitized, contentType: next.contentType, width: next.width, height: next.height };
}

async function requireSubmissionEnabled(env) {
  const row = await requireCommerceDb(env).prepare("SELECT value_json FROM commerce_settings WHERE setting_key = 'community_submission_enabled'").first();
  if (parseJson(row?.value_json, false) !== true) throw new AuthFailure(503, "submissions_unavailable", "GOATS submissions are not configured.");
}

async function requirePublicProduct(env, value) {
  const id = cleanText(value, 160);
  const row = await requireCommerceDb(env).prepare("SELECT id, slug, title FROM commerce_products WHERE id = ? AND status = 'active' AND visibility = 'public' LIMIT 1").bind(id).first();
  if (!row) throw new AuthFailure(400, "product_invalid", "Choose a product from the current catalogue.");
  return row;
}

async function requireDraft(env, tokenValue) {
  const token = String(tokenValue || "");
  if (token.length < 32 || token.length > 160) throw new AuthFailure(404, "draft_not_found", "The submission draft was not found.");
  const row = await requireCommerceDb(env).prepare("SELECT * FROM community_submissions WHERE draft_token_hash = ? AND status = 'draft' LIMIT 1").bind(await digestHex(token)).first();
  if (!row || Date.parse(row.draft_expires_at) <= Date.now()) throw new AuthFailure(410, "draft_expired", "This submission draft has expired.");
  return row;
}

async function requireVersion(env, id, expected) {
  const row = await requireCommerceDb(env).prepare("SELECT * FROM community_submissions WHERE id = ? AND status <> 'draft' LIMIT 1").bind(cleanText(id, 36)).first();
  if (!row) throw new AuthFailure(404, "submission_not_found", "The submission was not found.");
  if (!Number.isInteger(Number(expected)) || Number(expected) !== Number(row.version)) throw new AuthFailure(409, "version_conflict", "This submission changed in another tab. Reload before continuing.");
  return row;
}

async function assertApprovable(env, row) {
  const [product, media] = await Promise.all([
    requireCommerceDb(env).prepare("SELECT id FROM commerce_products WHERE id = ? AND status = 'active' AND visibility = 'public'").bind(row.product_id).first(),
    requireCommerceDb(env).prepare("SELECT role, processing_state FROM community_media WHERE submission_id = ?").bind(row.id).all(),
  ]);
  const entries = media?.results || [];
  const missing = [];
  if (!product) missing.push("product");
  if (!entries.some((item) => item.role === "main" && item.processing_state === "ready")) missing.push("main image");
  if (entries.some((item) => item.processing_state !== "ready")) missing.push("media processing");
  if (!row.public_slug || !/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(row.public_slug)) missing.push("slug");
  if (!Number.isFinite(row.public_latitude) || !Number.isFinite(row.public_longitude)) missing.push("approximate coordinates");
  if (!row.consent_version || !row.consented_at) missing.push("consent");
  if (!row.display_name || !row.description || !row.public_location_label) missing.push("public fields");
  if (missing.length) throw new AuthFailure(409, "approval_blocked", `Approval is blocked: ${missing.join(", ")}.`);
}

function allowedTransition(row, action) {
  if (action === "approve" && new Set(["pending", "rejected"]).has(row.status)) return { status: "approved", published: 1, event: "approved" };
  if (action === "reject" && row.status === "pending") return { status: "rejected", published: 0, event: "rejected" };
  if (action === "hide" && row.status === "approved" && Number(row.is_published) === 1) return { status: "approved", published: 0, event: "hidden" };
  if (action === "restore" && row.status === "approved" && Number(row.is_published) === 0) return { status: "approved", published: 1, event: "restored" };
  throw new AuthFailure(409, "status_transition_invalid", "This moderation transition is not allowed.");
}

async function publicListingRowBySlug(env, slug) {
  const row = await requireCommerceDb(env).prepare("SELECT * FROM community_submissions WHERE public_slug = ? AND status = 'approved' AND is_published = 1 LIMIT 1").bind(validSlug(slug)).first();
  if (!row) throw new AuthFailure(404, "goat_not_found", "This GOAT listing was not found.");
  return row;
}

async function publicNeighbours(env, approvedAt, id) {
  const db = requireCommerceDb(env);
  const [previous, next] = await Promise.all([
    db.prepare("SELECT public_slug, display_name FROM community_submissions WHERE status = 'approved' AND is_published = 1 AND (approved_at < ? OR (approved_at = ? AND id < ?)) ORDER BY approved_at DESC, id DESC LIMIT 1").bind(approvedAt, approvedAt, id).first(),
    db.prepare("SELECT public_slug, display_name FROM community_submissions WHERE status = 'approved' AND is_published = 1 AND (approved_at > ? OR (approved_at = ? AND id > ?)) ORDER BY approved_at ASC, id ASC LIMIT 1").bind(approvedAt, approvedAt, id).first(),
  ]);
  return { previous: previous ? { slug: previous.public_slug, displayName: previous.display_name } : null, next: next ? { slug: next.public_slug, displayName: next.display_name } : null };
}

function publicSelect() {
  return `SELECT s.id, s.public_slug, s.display_name, s.description, s.rating, s.public_location_label, s.country_code,
    s.public_latitude, s.public_longitude, s.product_id, s.product_slug_snapshot, s.product_name_snapshot, s.approved_at,
    (SELECT id FROM community_media m WHERE m.submission_id = s.id AND m.role = 'main' AND m.processing_state = 'ready' LIMIT 1) AS main_media_id,
    (SELECT id FROM community_media m WHERE m.submission_id = s.id AND m.role = 'profile' AND m.processing_state = 'ready' LIMIT 1) AS profile_media_id,
    (SELECT COUNT(*) FROM community_reactions r WHERE r.submission_id = s.id AND r.value = 1) AS like_count,
    (SELECT COUNT(*) FROM community_reactions r WHERE r.submission_id = s.id AND r.value = -1) AS dislike_count,
    (SELECT COUNT(*) FROM community_comments c WHERE c.submission_id = s.id AND c.status = 'visible') AS comment_count
    FROM community_submissions s`;
}

function publicListingProjection(row) {
  return {
    id: row.id,
    slug: row.public_slug,
    displayName: row.display_name,
    description: row.description,
    rating: row.rating == null ? null : Number(row.rating),
    publishedAt: row.approved_at,
    product: { id: row.product_id, slug: row.product_slug_snapshot, name: row.product_name_snapshot },
    location: { label: row.public_location_label, countryCode: row.country_code, latitude: row.public_latitude == null ? null : Number(row.public_latitude), longitude: row.public_longitude == null ? null : Number(row.public_longitude) },
    media: { main: mediaProjection(row.main_media_id ? { id: row.main_media_id, role: "main", sort_order: 0 } : null), profile: mediaProjection(row.profile_media_id ? { id: row.profile_media_id, role: "profile", sort_order: 0 } : null), gallery: [] },
    counts: { likes: Math.max(0, Number(row.like_count || 0)), dislikes: Math.max(0, Number(row.dislike_count || 0)), comments: Math.max(0, Number(row.comment_count || 0)) },
  };
}

function adminSummary(row) {
  return { id: row.id, reference: row.reference_code, displayName: row.display_name, status: row.status, published: Boolean(row.is_published), submittedAt: row.submitted_at, updatedAt: row.updated_at, product: { id: row.product_id, slug: row.product_slug_snapshot, name: row.product_name_snapshot }, rating: row.rating == null ? null : Number(row.rating), location: row.public_location_label, mediaCount: Number(row.media_count || 0), mainMediaUrl: row.main_media_id ? `/api/admin/goats/media/${row.main_media_id}` : null, emailState: row.email_state || null, version: Number(row.version || 1) };
}

function adminProjection(row, media, events, emails) {
  return {
    ...adminSummary(row),
    privateEmail: row.submitter_email,
    submitterAccountId: row.submitter_account_id,
    description: row.description,
    slug: row.public_slug,
    city: row.city,
    region: row.region,
    countryCode: row.country_code,
    latitude: row.public_latitude,
    longitude: row.public_longitude,
    consent: { version: row.consent_version, timestamp: row.consented_at },
    moderatorNote: row.moderator_note,
    rejectionReason: row.rejection_reason,
    media: media.map((item) => ({ id: item.id, role: item.role, sortOrder: Number(item.sort_order), contentType: item.content_type, byteSize: Number(item.byte_size), width: Number(item.width), height: Number(item.height), state: item.processing_state, error: item.processing_error, url: `/api/admin/goats/media/${item.id}` })),
    events: events.map((item) => ({ id: item.id, type: item.event_type, actorAccountId: item.actor_account_id, metadata: parseJson(item.metadata_json, {}), createdAt: item.created_at })),
    emails: emails.map((item) => ({ id: item.id, templateKey: item.template_key, status: item.status, attempts: Number(item.attempts), lastError: item.last_error, createdAt: item.created_at, updatedAt: item.updated_at, sentAt: item.sent_at })),
  };
}

function commentProjection(row) {
  return { id: row.id, displayName: row.author_display_name, avatarUrl: safePublicUrl(row.author_avatar_url), body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mediaProjection(row) {
  return row ? { id: row.id, role: row.role, sortOrder: Number(row.sort_order || 0), url: `/api/goats/media/${row.id}` } : null;
}

function moderationStatement(env, submissionId, actorId, eventType, metadata, timestamp) {
  return requireCommerceDb(env).prepare("INSERT INTO community_moderation_events (id, submission_id, actor_account_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(randomId(), submissionId, actorId || null, eventType, JSON.stringify(metadata || {}), timestamp);
}

function outboxStatement(env, templateKey, recipient, submissionId, idempotencyKey, variables, timestamp) {
  return requireCommerceDb(env).prepare(
    `INSERT OR IGNORE INTO community_email_outbox (id, template_key, recipient_email, submission_id, idempotency_key, variables_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(randomId(), templateKey, normalizeEmail(recipient), submissionId, idempotencyKey, JSON.stringify(variables), timestamp, timestamp);
}

async function mediaUpdateStatements(env, submissionId, mainMediaIdValue, mediaOrderValue) {
  const db = requireCommerceDb(env);
  const rows = await db.prepare("SELECT id, role, sort_order FROM community_media WHERE submission_id = ? ORDER BY role, sort_order").bind(submissionId).all();
  const media = rows?.results || [];
  const statements = [];
  const main = media.find((item) => item.role === "main");
  const requestedMain = media.find((item) => item.id === cleanText(mainMediaIdValue, 36));
  if (main && requestedMain && requestedMain.id !== main.id && requestedMain.role === "gallery") {
    const requestedOrder = Number(requestedMain.sort_order || 0);
    statements.push(db.prepare("UPDATE community_media SET role = 'gallery', sort_order = 5 WHERE id = ? AND submission_id = ?").bind(main.id, submissionId));
    statements.push(db.prepare("UPDATE community_media SET role = 'main', sort_order = 0 WHERE id = ? AND submission_id = ?").bind(requestedMain.id, submissionId));
    statements.push(db.prepare("UPDATE community_media SET sort_order = ? WHERE id = ? AND submission_id = ?").bind(requestedOrder, main.id, submissionId));
  }
  const requestedOrder = Array.isArray(mediaOrderValue) ? mediaOrderValue.map((value) => cleanText(value, 36)).filter(Boolean).slice(0, MAX_GOAT_GALLERY_IMAGES) : [];
  const galleryIds = new Set(media.filter((item) => item.role === "gallery" || item.id === main?.id && requestedMain?.id !== main?.id).map((item) => item.id));
  const ordered = requestedOrder.filter((id) => galleryIds.has(id));
  for (const id of galleryIds) if (!ordered.includes(id)) ordered.push(id);
  ordered.slice(0, MAX_GOAT_GALLERY_IMAGES).forEach((id, index) => statements.push(db.prepare("UPDATE community_media SET sort_order = ? WHERE id = ? AND submission_id = ? AND role = 'gallery'").bind(index, id, submissionId)));
  return statements;
}

async function enforceCommunityRateLimit(env, category, keyValue, limit, seconds) {
  const secret = String(env?.THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET || env?.THIRDRAILIFY_COMMUNITY_API_SECRET || "");
  if (!secret) throw new AuthFailure(503, "rate_limit_not_configured", "Submission protection is not configured.");
  const keyHash = await digestHex(`${secret}\n${category}\n${cleanText(keyValue, 300)}`);
  const db = requireCommerceDb(env);
  const row = await db.prepare("SELECT * FROM community_rate_limits WHERE key_hash = ? AND category = ?").bind(keyHash, category).first();
  const now = Date.now();
  if (row?.blocked_until && Date.parse(row.blocked_until) > now) throw new AuthFailure(429, "too_many_requests", "Too many requests. Try again later.");
  const reset = !row || now - Date.parse(row.window_started_at) >= seconds * 1000;
  const count = reset ? 1 : Number(row.request_count || 0) + 1;
  const timestamp = nowIso(now);
  const blocked = count > limit ? new Date(now + seconds * 1000).toISOString() : null;
  await db.prepare(
    `INSERT INTO community_rate_limits (key_hash, category, window_started_at, request_count, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key_hash, category) DO UPDATE SET window_started_at = excluded.window_started_at, request_count = excluded.request_count, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`,
  ).bind(keyHash, category, reset ? timestamp : row.window_started_at, count, blocked, timestamp).run();
  if (blocked) throw new AuthFailure(429, "too_many_requests", "Too many requests. Try again later.");
}

async function uniqueSlug(env, value, currentId = "") {
  const base = slugify(value);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix ? `${base.slice(0, 112)}-${suffix + 1}` : base;
    const existing = await requireCommerceDb(env).prepare("SELECT id FROM community_submissions WHERE public_slug = ? LIMIT 1").bind(candidate).first();
    if (!existing || existing.id === currentId) return candidate;
  }
  return `${base.slice(0, 80)}-${randomId().slice(0, 8)}`;
}

function slugify(value) {
  const result = cleanText(value, 120).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return result.length >= 3 ? result : `goat-${randomId().slice(0, 8)}`;
}

function validSlug(value) {
  const slug = cleanText(value, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(slug)) throw new AuthFailure(404, "goat_not_found", "This GOAT listing was not found.");
  return slug;
}

function requiredText(value, min, max, code) {
  const text = cleanText(value, max);
  if (text.length < min) throw new AuthFailure(400, code, "A required field is missing or invalid.");
  return text;
}

function countryCode(value, optional) {
  const code = cleanText(value, 2).toUpperCase();
  if (!code && optional) return "";
  if (!/^[A-Z]{2}$/.test(code)) throw new AuthFailure(400, "country_invalid", "Choose a valid country.");
  return code;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function coordinate(value, min, max, optional) {
  if (value === "" || value == null) return optional ? null : NaN;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new AuthFailure(400, "coordinates_invalid", "Enter valid approximate coordinates.");
  return Math.round(number * 1000) / 1000;
}

function safePublicUrl(value) {
  if (!value) return null;
  try { const url = new URL(String(value)); return url.protocol === "https:" && !url.username && !url.password ? url.toString().slice(0, 1024) : null; } catch { return null; }
}

function supportUrl(env) {
  const email = normalizeEmail(env?.MAIL_REPLY_TO || "info@thirdrailify.com") || "info@thirdrailify.com";
  return `mailto:${email}`;
}

function adminOrigin(env) {
  return normalizeOrigin(env?.THIRDRAILIFY_ADMIN_ORIGIN) || "https://thirdrailify-admin.pages.dev";
}

function publicOrigin(env) {
  return normalizeOrigin(env?.THIRDRAILIFY_PUBLIC_ORIGIN) || "https://thirdrailify.pages.dev";
}

function configuredAdminRecipients(env) {
  const explicit = String(env?.THIRDRAILIFY_GOATS_ADMIN_RECIPIENTS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
  return explicit.length ? [...new Set(explicit)] : [1, 2, 3, 4].map((index) => normalizeEmail(env?.[`ADMIN_EMAIL_${index}`])).filter(Boolean);
}

function submissionVariables(env, row) {
  return { display_name: row.display_name, submission_reference: row.reference_code, product_name: row.product_name_snapshot, submitted_date: row.submitted_at, status: row.status, public_listing_url: `${publicOrigin(env)}/goats/${row.public_slug}`, rejection_reason: row.rejection_reason || "The submission did not meet the current publication requirements.", support_url: supportUrl(env) };
}

function templateText(value, min, max, allowHtml = false) {
  const text = String(value || "").trim().slice(0, max);
  if (text.length < min || /\u0000/.test(text) || (!allowHtml && /<[^>]+>/.test(text))) throw new AuthFailure(400, "template_invalid", "The template content is invalid.");
  return text;
}

function renderTemplate(template, variables, html) {
  return String(template).replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
    const value = cleanText(variables?.[key], 2048);
    return html ? escapeHtml(value) : value;
  });
}

export function brandedGoatEmailHtml(content, templateKey, origin = "https://thirdrailify-admin.pages.dev") {
  const labels = {
    goat_submission_received: "Submission received",
    goat_submission_admin_alert: "Moderation requested",
    goat_submission_approved: "Approved dispatch",
    goat_submission_rejected: "Submission update",
  };
  const label = labels[templateKey] || "Community notification";
  const assetOrigin = normalizeOrigin(origin) || "https://thirdrailify-admin.pages.dev";
  const assets = `${assetOrigin}/email-assets`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(label)}</title><style>@font-face{font-family:'American Captain';src:url('${assets}/american-captain.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:'Blinker';src:url('${assets}/blinker-regular.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:'Blinker';src:url('${assets}/blinker-semibold.ttf') format('truetype');font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:'Geist Mono';src:url('${assets}/geist-mono.ttf') format('truetype');font-weight:100 900;font-style:normal;font-display:swap}@media(max-width:640px){.tr-card{width:100%!important}.tr-pad{padding:28px 22px!important}.tr-content h1{font-size:42px!important}}.tr-content a{display:inline-block;margin-top:8px;padding:13px 18px;border-radius:6px;background:#f3c928;color:#090907!important;font-family:'Geist Mono','Courier New',monospace;font-size:12px;font-weight:700;letter-spacing:.06em;text-decoration:none;text-transform:uppercase}.tr-content h1{margin:0 0 18px;color:#17160f;font-family:'American Captain','Arial Narrow',Impact,sans-serif;font-size:52px;font-weight:400;letter-spacing:.01em;line-height:.96;text-transform:uppercase}.tr-content p{margin:0 0 15px;color:#4d493a;font-family:'Blinker',Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65}.tr-content strong{color:#17160f;font-family:'Blinker',Arial,Helvetica,sans-serif;font-weight:600}</style></head><body style="margin:0;padding:0;background:#080806;color:#f5f1e5;font-family:'Blinker',Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#080806"><tr><td align="center" style="padding:34px 16px"><table role="presentation" class="tr-card" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:100%;overflow:hidden;border:1px solid #3b351d;border-radius:12px;background:#f3f0e5"><tr><td style="padding:22px 28px;background:#11110e"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td width="50" valign="middle"><img src="${assets}/trzapcolorcon.svg" width="38" height="38" alt="" style="display:block;width:38px;height:38px;border:0"></td><td valign="middle"><strong style="display:block;color:#f5f1e5;font-family:'American Captain','Arial Narrow',Impact,sans-serif;font-size:27px;font-weight:400;letter-spacing:.01em;line-height:1;text-transform:uppercase">THIRD RAILIFY OFFICIAL</strong><span style="display:block;margin-top:4px;color:#b7b19d;font-family:'Geist Mono','Courier New',monospace;font-size:9px;font-weight:500;letter-spacing:.12em;text-transform:uppercase">GOATS in the Wild</span></td></tr></table></td></tr><tr><td height="5" style="height:5px;background:#f3c928"></td></tr><tr><td class="tr-pad" style="padding:38px 42px"><div style="margin-bottom:12px;color:#9b7c05;font-family:'Geist Mono','Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase">${escapeHtml(label)}</div><div class="tr-content">${String(content || "")}</div></td></tr><tr><td style="padding:20px 28px;border-top:1px solid #d5cebb;background:#e8e3d4;color:#655f4c;font-family:'Blinker',Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55"><strong style="color:#3f3b2e;font-weight:600">Third Railify Official</strong><br>Community stories are reviewed before publication. Locations shown publicly are deliberately approximate.</td></tr></table><div style="padding:18px 8px;color:#77715f;font-family:'Geist Mono','Courier New',monospace;font-size:10px;line-height:1.5">This transactional message was generated by the Admin-authoritative GOATS workflow.</div></td></tr></table></body></html>`;
}

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function escapeLike(value) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }

function requireMediaBucket(env) {
  const bucket = env?.[GOATS_MEDIA_BINDING];
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") throw new AuthFailure(503, "community_media_not_configured", "GOATS media storage is not configured.");
  return bucket;
}

async function digestHex(value) { return digestBytesHex(encoder.encode(String(value))); }
async function digestBytesHex(value) { const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", value)); return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

function detectImage(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    const dimensions = jpegDimensions(bytes); return dimensions ? { contentType: "image/jpeg", ...dimensions } : null;
  }
  if (bytes.length >= 24 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value) && ascii(bytes, 12, 16) === "IHDR" && ascii(bytes, bytes.length - 8, bytes.length - 4) === "IEND") {
    return { contentType: "image/png", width: uint32Be(bytes, 16), height: uint32Be(bytes, 20) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP" && uint32Le(bytes, 4) + 8 === bytes.length) {
    const dimensions = webpDimensions(bytes); return dimensions ? { contentType: "image/webp", ...dimensions } : null;
  }
  return null;
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if (new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]).has(marker)) return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    offset += length + 2;
  }
  return null;
}

function sanitizeJpeg(bytes) {
  const chunks = [bytes.slice(0, 2)]; let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new AuthFailure(415, "image_format_invalid", "The JPEG structure is invalid.");
    const marker = bytes[offset + 1];
    if (marker === 0xda) { chunks.push(bytes.slice(offset)); break; }
    if (marker === 0xd9) { chunks.push(bytes.slice(offset, offset + 2)); break; }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + length + 2 > bytes.length) throw new AuthFailure(415, "image_format_invalid", "The JPEG structure is invalid.");
    if (![0xe1, 0xed, 0xfe].includes(marker)) chunks.push(bytes.slice(offset, offset + length + 2));
    offset += length + 2;
  }
  return concatBytes(chunks);
}

function sanitizePng(bytes) {
  const chunks = [bytes.slice(0, 8)]; let offset = 8; const safeAncillary = new Set(["tRNS", "sRGB", "gAMA", "cHRM"]);
  while (offset + 12 <= bytes.length) {
    const length = uint32Be(bytes, offset); const end = offset + 12 + length;
    if (end > bytes.length) throw new AuthFailure(415, "image_format_invalid", "The PNG structure is invalid.");
    const type = ascii(bytes, offset + 4, offset + 8);
    const critical = type[0] === type[0].toUpperCase();
    if (critical || safeAncillary.has(type)) chunks.push(bytes.slice(offset, end));
    offset = end; if (type === "IEND") break;
  }
  return concatBytes(chunks);
}

function sanitizeWebp(bytes) {
  const chunks = []; let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4); const length = uint32Le(bytes, offset + 4); const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) throw new AuthFailure(415, "image_format_invalid", "The WebP structure is invalid.");
    if (!new Set(["EXIF", "XMP ", "ICCP"]).has(type)) chunks.push(bytes.slice(offset, end));
    offset = end;
  }
  const body = concatBytes(chunks); const result = new Uint8Array(12 + body.length);
  result.set(encoder.encode("RIFF"), 0); writeUint32Le(result, 4, result.length - 8); result.set(encoder.encode("WEBP"), 8); result.set(body, 12); return result;
}

function webpDimensions(bytes) {
  const type = ascii(bytes, 12, 16);
  if (type === "VP8X") return { width: 1 + uint24Le(bytes, 24), height: 1 + uint24Le(bytes, 27) };
  if (type === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: ((bytes[27] << 8) | bytes[26]) & 0x3fff, height: ((bytes[29] << 8) | bytes[28]) & 0x3fff };
  if (type === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = uint32Le(bytes, 21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  return null;
}

function ascii(bytes, start, end) { return String.fromCharCode(...bytes.slice(start, end)); }
function uint32Le(bytes, offset) { return (bytes[offset] | bytes[offset+1] << 8 | bytes[offset+2] << 16 | bytes[offset+3] << 24) >>> 0; }
function uint32Be(bytes, offset) { return ((bytes[offset] << 24) | (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3]) >>> 0; }
function uint24Le(bytes, offset) { return bytes[offset] | bytes[offset+1] << 8 | bytes[offset+2] << 16; }
function writeUint32Le(bytes, offset, value) { bytes[offset]=value&255; bytes[offset+1]=(value>>>8)&255; bytes[offset+2]=(value>>>16)&255; bytes[offset+3]=(value>>>24)&255; }
function concatBytes(chunks) { const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
