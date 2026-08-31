import { publicCataloguePayload } from "../../../_shared/public-catalogue.js";

export async function onRequestGet({ env }) {
  try {
    return Response.json(await publicCataloguePayload(env), { headers: noStoreHeaders() });
  } catch {
    return Response.json({ ok: false, error: "catalogue_unavailable", message: "The shop catalogue is temporarily unavailable." }, { status: 503, headers: noStoreHeaders() });
  }
}

function noStoreHeaders() { return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }; }
