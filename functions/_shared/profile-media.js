import {
  AuthFailure,
  enforceRateLimit,
  loadAccountById,
  nowIso,
  readJsonBody,
  requireAuthDb,
  requireCsrf,
  requireSession,
  serializeAccount,
  sessionEnvelope,
  writeAudit,
} from "./auth-core.js";
import { publicMediaOrigin } from "./media-origin.js";

export const PROFILE_MEDIA_BINDING = "THIRDRAILIFY_PROFILE_MEDIA";
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export async function updateAvatar(request, env, fetchImpl = fetch) {
  const session = await requireSession(env, request);
  await requireCsrf(request, session);
  await enforceRateLimit(env, request, "avatar", session.accountId);
  const bucket = requireProfileMediaBucket(env);
  const mediaOrigin = profileMediaOrigin(env);
  const image = await readAvatarImage(request, fetchImpl);
  const accountKey = (await digestHex(new TextEncoder().encode(`account:${session.accountId}`))).slice(0, 20);
  const contentHash = await digestHex(image.bytes);
  const objectKey = `u/${accountKey}/avatar/${contentHash}.${image.extension}`;
  const existing = typeof bucket.head === "function" ? await bucket.head(objectKey) : null;

  if (!existing) {
    await bucket.put(objectKey, image.bytes, {
      httpMetadata: {
        contentType: image.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { kind: "avatar", schema: "thirdrailify-profile-media-v1" },
    });
  }

  const avatarUrl = `${mediaOrigin}/${objectKey}`;
  const timestamp = nowIso();
  try {
    const result = await requireAuthDb(env)
      .prepare("UPDATE accounts SET avatar_url = ?, updated_at = ? WHERE id = ? AND status = 'active'")
      .bind(avatarUrl, timestamp, session.accountId)
      .run();
    if (Number(result?.meta?.changes || 0) !== 1) {
      throw new AuthFailure(409, "account_unavailable", "This account cannot update its avatar.");
    }
  } catch (error) {
    if (!existing && typeof bucket.delete === "function") await bucket.delete(objectKey).catch(() => undefined);
    throw error;
  }

  await writeAudit(env, {
    actorAccountId: session.accountId,
    targetAccountId: session.accountId,
    eventType: "avatar_updated",
    result: "success",
    metadata: { source: image.source, contentType: image.contentType, bytes: image.bytes.byteLength },
  });
  const account = await serializeAccount(env, await loadAccountById(env, session.accountId));
  return sessionEnvelope(env, { ...session, account });
}

export async function profileMediaResponse(request, env) {
  if (!new Set(["GET", "HEAD"]).has(request.method)) {
    throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET, HEAD" });
  }
  let objectKey;
  try {
    objectKey = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
  } catch {
    throw new AuthFailure(400, "media_path_invalid", "The media path is invalid.");
  }
  if (!/^u\/[a-f0-9]{20}\/avatar\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(objectKey)) {
    throw new AuthFailure(404, "media_not_found", "The profile image was not found.");
  }
  const object = await requireProfileMediaBucket(env).get(objectKey);
  if (!object) throw new AuthFailure(404, "media_not_found", "The profile image was not found.");
  const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1);
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": object.httpMetadata?.contentType || contentTypeForExtension(extension),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  if (Number.isFinite(object.size)) headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function requireProfileMediaBucket(env) {
  const bucket = env?.[PROFILE_MEDIA_BINDING];
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") {
    throw new AuthFailure(503, "profile_media_not_configured", "Profile image storage is not configured.");
  }
  return bucket;
}

function profileMediaOrigin(env) {
  const origin = publicMediaOrigin(env);
  if (!origin || !origin.startsWith("https://")) {
    throw new AuthFailure(503, "profile_media_not_configured", "The profile image origin is not configured.");
  }
  return origin;
}

async function readAvatarImage(request, fetchImpl) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES + 64 * 1024) {
    throw new AuthFailure(413, "avatar_too_large", "Choose an image no larger than 5 MB.");
  }
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) {
    const data = await request.formData();
    const file = data.get("avatar");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
      throw new AuthFailure(400, "avatar_file_required", "Choose a JPG, PNG, or WebP image.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return validatedImage(bytes, file.type, "upload");
  }
  if (contentType.startsWith("application/json")) {
    const body = await readJsonBody(request);
    const url = validatedRemoteImageUrl(body.imageUrl);
    const response = await fetchRemoteImage(url, fetchImpl);
    const bytes = await readLimitedResponse(response);
    return validatedImage(bytes, response.headers.get("content-type"), "url");
  }
  throw new AuthFailure(415, "avatar_content_type", "Upload a JPG, PNG, or WebP file, or provide an HTTPS image URL.");
}

async function fetchRemoteImage(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "image/webp,image/png,image/jpeg" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || response.status >= 300) throw new AuthFailure(400, "avatar_url_unavailable", "The image URL could not be read.");
    const length = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(length) && length > MAX_AVATAR_BYTES) throw new AuthFailure(413, "avatar_too_large", "Choose an image no larger than 5 MB.");
    return response;
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure(400, "avatar_url_unavailable", "The image URL could not be read.");
  } finally {
    clearTimeout(timeout);
  }
}

function validatedRemoteImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new AuthFailure(400, "avatar_url_invalid", "Enter a valid HTTPS image URL.");
  }
  const hostname = url.hostname.toLowerCase();
  const unsafeHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || unsafeHost) {
    throw new AuthFailure(400, "avatar_url_invalid", "Enter a public HTTPS image URL without credentials, fragments, or a custom port.");
  }
  return url.toString().slice(0, 2048);
}

function validatedImage(bytes, declaredType, source) {
  if (!bytes.byteLength) throw new AuthFailure(400, "avatar_empty", "The image is empty.");
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new AuthFailure(413, "avatar_too_large", "Choose an image no larger than 5 MB.");
  const detectedType = detectImageType(bytes);
  const rawDeclaredType = String(declaredType || "").split(";", 1)[0].trim().toLowerCase();
  const normalizedDeclaredType = rawDeclaredType === "image/jpg" ? "image/jpeg" : rawDeclaredType;
  if (!detectedType || (normalizedDeclaredType && normalizedDeclaredType !== detectedType)) {
    throw new AuthFailure(415, "avatar_format_invalid", "The file must be a valid JPG, PNG, or WebP image.");
  }
  return { bytes, contentType: detectedType, extension: IMAGE_TYPES.get(detectedType), source };
}

async function readLimitedResponse(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_AVATAR_BYTES) throw new AuthFailure(413, "avatar_too_large", "Choose an image no larger than 5 MB.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AVATAR_BYTES) {
      await reader.cancel();
      throw new AuthFailure(413, "avatar_too_large", "Choose an image no larger than 5 MB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function detectImageType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (
    bytes.length >= 32 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value) &&
    ascii(bytes, bytes.length - 8, bytes.length - 4) === "IEND"
  ) return "image/png";
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP" && uint32Le(bytes, 4) + 8 === bytes.length) return "image/webp";
  return "";
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function uint32Le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function digestHex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentTypeForExtension(extension) {
  return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
}
