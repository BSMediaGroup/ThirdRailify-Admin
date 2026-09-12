// Presentation URL only: stored assignments retain their canonical CDN identity.
export function displayCommerceMedia(url: string | null | undefined) {
  return url?.replace(/^https:\/\/cdn\.thirdrailify\.com\/commerce-media\/([a-f0-9]{64}\.(?:jpg|png|webp))$/, '/api/public/commerce/media/$1') || '';
}
