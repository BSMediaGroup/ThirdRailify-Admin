import { AuthFailure, errorResponse, jsonResponse } from "../../_shared/auth-core.js";
import {
  accountAddressCreate,
  accountAddressDelete,
  accountAddressSetDefault,
  accountAddressUpdate,
  accountCommerceContactUpdate,
  accountCommerceOverview,
  accountOrderDetail,
  accountOrderHistory,
  accountInboxMessages,
  mutateAccountInbox,
  enforceAccountCommerceRateLimit,
  readAccountCommerceInternalBody,
  verifyAccountCommerceInternalRequest,
} from "../../_shared/account-commerce.js";

const PREFIX = "/api/account-commerce";

export async function onRequest({ request, env }) {
  try {
    if (request.method !== "POST") throw new AuthFailure(405, "method_not_allowed", "This account-commerce method is not allowed.", { Allow: "POST" });
    const path = new URL(request.url).pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (!path.startsWith("internal/")) throw new AuthFailure(404, "account_commerce_route_not_found", "The account-commerce route was not found.");
    const { body, raw } = await readAccountCommerceInternalBody(request);
    await verifyAccountCommerceInternalRequest(request, env, raw);
    const accountId = String(body.accountId || "");
    const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
    const internalPath = path.slice("internal/".length);
    const mutation = internalPath === "contact" || internalPath === "addresses/create" || internalPath === "inbox/mutate" || /^addresses\/adr_[0-9a-f-]{36}\/(?:update|delete|default)$/.test(internalPath);
    await enforceAccountCommerceRateLimit(env, request, accountId, mutation);
    let payload;
    if (internalPath === "overview") payload = await accountCommerceOverview(env, accountId);
    else if (internalPath === "inbox") payload = await accountInboxMessages(env, accountId, input);
    else if (internalPath === "inbox/mutate") payload = await mutateAccountInbox(env, accountId, input);
    else if (internalPath === "contact") payload = await accountCommerceContactUpdate(env, accountId, input);
    else if (internalPath === "addresses/create") payload = await accountAddressCreate(env, accountId, input);
    else if (internalPath === "orders") payload = await accountOrderHistory(env, accountId, input);
    else {
      const address = internalPath.match(/^addresses\/(adr_[0-9a-f-]{36})\/(update|delete|default)$/);
      const order = internalPath.match(/^orders\/(ord_[A-Za-z0-9_-]{1,150})$/);
      if (address?.[2] === "update") payload = await accountAddressUpdate(env, accountId, address[1], input);
      else if (address?.[2] === "delete") payload = await accountAddressDelete(env, accountId, address[1]);
      else if (address?.[2] === "default") payload = await accountAddressSetDefault(env, accountId, address[1]);
      else if (order) payload = await accountOrderDetail(env, accountId, order[1]);
      else throw new AuthFailure(404, "account_commerce_route_not_found", "The account-commerce route was not found.");
    }
    return jsonResponse(payload, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return errorResponse(error, request, env);
  }
}
