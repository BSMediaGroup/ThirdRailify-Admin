import { publicCataloguePayload } from "../../../_shared/public-catalogue.js";

export async function onRequestGet({ env }) {
  try {
    return Response.json(await publicCataloguePayload(env), { headers: publicCacheHeaders() });
  } catch {
    return Response.json({ ok: false, error: "catalogue_unavailable", message: "The shop catalogue is temporarily unavailable." }, { status: 503, headers: noStoreHeaders() });
  }
}

function publicCacheHeaders() { return { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600", "X-Content-Type-Options": "nosniff" }; }
function noStoreHeaders() { return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }; }
