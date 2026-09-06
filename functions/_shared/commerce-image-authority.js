// Hosting/custody never establishes editorial intent.
export function imageList(metadata) { return [...new Set([metadata.publicImage, ...(metadata.publicImages || [])].filter(Boolean))]; }
export function editedImageAuthority(previous, requested, timestamp) {
  if (JSON.stringify(imageList(previous)) === JSON.stringify(requested)) return previous.imageAuthority;
  const knownProvider = new Set([...(previous.providerCatalogue?.imageUrls || []), ...(previous.providerAssets || []).map((asset) => asset.url)]);
  const old = previous.imageAuthority || {};
  // An unresolved historical override remains unresolved until the explicit restore choice.
  if (old.kind === "editorial_override" && old.version !== 2) return { ...old, updatedAt: timestamp };
  return { kind: "editorial_override", version: 2, source: "admin_product_editor", updatedAt: timestamp,
    primaryLocked: requested[0] !== previous.publicImage ? true : old.primaryLocked === true,
    manualImages: requested.filter((url) => !knownProvider.has(url)),
    order: requested,
    excludedProviderImages: [...knownProvider].filter((url) => !requested.includes(url)) };
}
