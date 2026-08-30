import { AuthFailure, cleanText, nowIso } from "./auth-core.js";
import { requireCommerceDb, writeCommerceAudit } from "./commerce-core.js";
import { publicMediaOrigin } from "./media-origin.js";

const MEDIA_BINDING = "THIRDRAILIFY_PROFILE_MEDIA";
export const MAX_COMMERCE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_COMMERCE_PRODUCT_IMAGES = 25;
const IMAGE_TYPES = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);

export async function ingestCommerceProductMedia(env, session, productId, input, fetchImpl = fetch) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "imageUrls")) {
    throw new AuthFailure(400, "commerce_media_request_invalid", "The product-media request is invalid.");
  }
  const id = cleanText(productId, 160);
  if (!id || !(await requireCommerceDb(env).prepare("SELECT id FROM commerce_products WHERE id = ?").bind(id).first())) {
    throw new AuthFailure(404, "commerce_product_not_found", "The commerce product was not found.");
  }
  if (!Array.isArray(input.imageUrls) || input.imageUrls.length > MAX_COMMERCE_PRODUCT_IMAGES || input.imageUrls.some((value) => typeof value !== "string" || value.length > 4096)) {
    throw new AuthFailure(400, "commerce_media_urls_invalid", `Supply no more than ${MAX_COMMERCE_PRODUCT_IMAGES} image URLs.`);
  }
  const urls = [...new Set(input.imageUrls.map((value) => value.trim()).filter(Boolean))];
  const assets = [];
  for (const sourceUrl of urls) assets.push(await ingestOne(env, sourceUrl, fetchImpl));
  await writeCommerceAudit(env, {
    actorAccountId: session?.accountId,
    action: "commerce.product_media_ingested",
    targetType: "commerce_product",
    targetId: id,
    result: "success",
    metadata: { imageCount: assets.length, newObjectCount: assets.filter((asset) => asset.created).length },
  });
  return {
    ok: true,
    productId: id,
    primaryImageUrl: assets[0]?.url || null,
    additionalImages: assets.slice(1).map((asset) => asset.url),
    assets: assets.map(({ url, sha256, contentType, bytes }) => ({ url, sha256, contentType, bytes })),
    ingestedAt: nowIso(),
  };
}

export async function uploadCommerceProductMedia(env, session, productId, request) {
  const id = await requireProduct(env, productId);
  const image = await readDirectUpload(request);
  const asset = await storeImage(env, image.bytes, image.contentType);
  await writeCommerceAudit(env, {
    actorAccountId: session?.accountId,
    action: "commerce.product_media_uploaded",
    targetType: "commerce_product",
    targetId: id,
    result: "success",
    metadata: { source: "direct_upload", contentType: asset.contentType, bytes: asset.bytes, created: asset.created },
  });
  return {
    ok: true,
    productId: id,
    asset: publicAsset(asset),
    limits: mediaLimits(),
    uploadedAt: nowIso(),
  };
}

export function commerceMediaLimits() {
  return { ok: true, limits: mediaLimits() };
}

export async function commerceMediaResponse(request, env) {
  if (!new Set(["GET", "HEAD"]).has(request.method)) throw new AuthFailure(405, "method_not_allowed", "This method is not allowed.", { Allow: "GET, HEAD" });
  let name;
  try { name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/commerce-media\//, "")); }
  catch { throw new AuthFailure(400, "commerce_media_path_invalid", "The commerce media path is invalid."); }
  if (!/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(name)) throw new AuthFailure(404, "commerce_media_not_found", "The commerce image was not found.");
  const object = await requireMediaBucket(env).get(`commerce/catalogue/${name}`);
  if (!object) throw new AuthFailure(404, "commerce_media_not_found", "The commerce image was not found.");
  const extension = name.slice(name.lastIndexOf(".") + 1);
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": object.httpMetadata?.contentType || (extension === "jpg" ? "image/jpeg" : `image/${extension}`),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  if (Number.isFinite(object.size)) headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

async function ingestOne(env, source, fetchImpl) {
  const sourceUrl = validatedRemoteUrl(source);
  const origin = mediaOrigin(env);
  const existingName = sourceUrl.startsWith(`${origin}/commerce-media/`) ? sourceUrl.slice(`${origin}/commerce-media/`.length) : "";
  if (/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(existingName)) {
    const existing = await requireMediaBucket(env).head(`commerce/catalogue/${existingName}`);
    if (!existing) throw new AuthFailure(409, "commerce_media_object_missing", "The referenced first-party commerce image is missing from storage.");
    const extension = existingName.slice(existingName.lastIndexOf(".") + 1);
    return { url: sourceUrl, sha256: existingName.slice(0, 64), contentType: existing.httpMetadata?.contentType || (extension === "jpg" ? "image/jpeg" : `image/${extension}`), bytes: Number(existing.size || 0), created: false };
  }
  const response = await fetchImage(sourceUrl, fetchImpl);
  const bytes = await readLimited(response);
  const image = validatedImage(bytes, response.headers.get("content-type"));
  return storeImage(env, bytes, image.contentType);
}

async function storeImage(env, bytes, contentType) {
  const image = validatedImage(bytes, contentType);
  const origin = mediaOrigin(env);
  const sha256 = await digestHex(bytes);
  const name = `${sha256}.${image.extension}`;
  const objectKey = `commerce/catalogue/${name}`;
  const bucket = requireMediaBucket(env);
  const existing = await bucket.head(objectKey);
  if (!existing) await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: image.contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { kind: "commerce_catalogue_image", schema: "thirdrailify-commerce-media-v1" },
  });
  return { url: `${origin}/commerce-media/${name}`, sha256, contentType: image.contentType, bytes: bytes.byteLength, created: !existing };
}

async function requireProduct(env, productId) {
  const id = cleanText(productId, 160);
  if (!id || !(await requireCommerceDb(env).prepare("SELECT id FROM commerce_products WHERE id = ?").bind(id).first())) {
    throw new AuthFailure(404, "commerce_product_not_found", "The commerce product was not found.");
  }
  return id;
}

async function readDirectUpload(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COMMERCE_IMAGE_BYTES + 256 * 1024) {
    throw new AuthFailure(413, "commerce_media_too_large", "Each product image must be no larger than 10 MB.");
  }
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    throw new AuthFailure(415, "commerce_media_content_type_invalid", "Upload a JPG, PNG, or WebP file using multipart form data.");
  }
  let data;
  try { data = await request.formData(); }
  catch { throw new AuthFailure(400, "commerce_media_form_invalid", "The product-media upload could not be read."); }
  const entries = [...data.entries()];
  const file = data.get("image");
  if (entries.length !== 1 || entries[0]?.[0] !== "image" || !file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    throw new AuthFailure(400, "commerce_media_file_required", "Choose one JPG, PNG, or WebP image.");
  }
  if (Number(file.size || 0) > MAX_COMMERCE_IMAGE_BYTES) {
    throw new AuthFailure(413, "commerce_media_too_large", "Each product image must be no larger than 10 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = validatedImage(bytes, file.type);
  return { bytes, contentType: image.contentType };
}

function requireMediaBucket(env) {
  const bucket = env?.[MEDIA_BINDING];
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.head !== "function" || typeof bucket.put !== "function") {
    throw new AuthFailure(503, "commerce_media_not_configured", "Commerce image storage is not configured.");
  }
  return bucket;
}

function mediaOrigin(env) {
  const origin = publicMediaOrigin(env);
  if (!origin?.startsWith("https://")) throw new AuthFailure(503, "commerce_media_not_configured", "The commerce media origin is not configured.");
  return origin;
}

function validatedRemoteUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new AuthFailure(400, "commerce_media_url_invalid", "Enter a valid public HTTPS image URL."); }
  const hostname = url.hostname.toLowerCase();
  const unsafe = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || unsafe) throw new AuthFailure(400, "commerce_media_url_invalid", "Enter a public HTTPS image URL without credentials, fragments, or a custom port.");
  return url.href;
}

async function fetchImage(url, fetchImpl) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(url, { method: "GET", headers: { Accept: "image/webp,image/png,image/jpeg" }, redirect: "manual", signal: controller.signal });
    if (!response.ok || response.status >= 300) throw new AuthFailure(400, "commerce_media_url_unavailable", "The image URL could not be read.");
    const length = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(length) && length > MAX_COMMERCE_IMAGE_BYTES) throw new AuthFailure(413, "commerce_media_too_large", "Each product image must be no larger than 10 MB.");
    return response;
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure(400, "commerce_media_url_unavailable", "The image URL could not be read.");
  } finally { clearTimeout(timeout); }
}

async function readLimited(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new AuthFailure(400, "commerce_media_empty", "The product image is empty.");
  if (bytes.byteLength > MAX_COMMERCE_IMAGE_BYTES) throw new AuthFailure(413, "commerce_media_too_large", "Each product image must be no larger than 10 MB.");
  return bytes;
}

function validatedImage(bytes, declaredType) {
  const contentType = detectImageType(bytes); const declared = String(declaredType || "").split(";", 1)[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  if (!contentType || (declared && declared !== contentType)) throw new AuthFailure(415, "commerce_media_format_invalid", "Product images must be valid JPG, PNG, or WebP files.");
  return { contentType, extension: IMAGE_TYPES.get(contentType) };
}

function detectImageType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (bytes.length >= 32 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value,index) => bytes[index] === value) && ascii(bytes, bytes.length - 8, bytes.length - 4) === "IEND") return "image/png";
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP" && uint32Le(bytes, 4) + 8 === bytes.length) return "image/webp";
  return "";
}
function ascii(bytes, start, end) { return String.fromCharCode(...bytes.slice(start, end)); }
function uint32Le(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
async function digestHex(bytes) { const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function publicAsset({ url, sha256, contentType, bytes }) { return { url, sha256, contentType, bytes }; }
function mediaLimits() { return { maxBytes: MAX_COMMERCE_IMAGE_BYTES, maxProductImages: MAX_COMMERCE_PRODUCT_IMAGES, maxAdditionalImages: MAX_COMMERCE_PRODUCT_IMAGES - 1, acceptedTypes: [...IMAGE_TYPES.keys()] }; }
