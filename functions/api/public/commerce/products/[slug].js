import { AuthFailure } from "../../../../_shared/auth-core.js";
import { publicProductPayload } from "../../../../_shared/public-catalogue.js";

export async function onRequestGet({ env, params }) {
  try {
    return Response.json(await publicProductPayload(env, params.slug), { headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    const notFound = error instanceof AuthFailure && error.status === 404;
    return Response.json({ ok: false, error: notFound ? "product_not_found" : "catalogue_unavailable", message: notFound ? "The product was not found." : "The shop catalogue is temporarily unavailable." }, { status: notFound ? 404 : 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
