import { errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import { merchandisingProductsPayload } from "../../_shared/commerce-core.js";

export async function onRequestGet({ request, env }) {
  try {
    const payload = await merchandisingProductsPayload(env, null);
    const publicProducts = payload.products.map(({ id, slug, featured, featuredOrder }) => ({ id, slug, featured, featuredOrder }));
    return jsonResponse({ ok: true, products: publicProducts, updatedAt: payload.updatedAt }, {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}
