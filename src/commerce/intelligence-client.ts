export type CommerceIntelligenceRange = "24h" | "7d" | "30d" | "90d";
export type FinancialMetric = { value: number | null; knownValue: number; complete: boolean };
export type FinancialDelta = { available: boolean; value: number | null; direction: "up" | "down" | "neutral" | "new" | "unavailable" };
export type CurrencySummary = {
  currencyCode: string;
  metrics: Record<string, FinancialMetric>;
  counts: { orders: number; donations: number; transactions: number; refundedOrders: number; disputes: number };
  comparisonComplete: boolean;
  previous: { metrics: Record<string, FinancialMetric>; counts: CurrencySummary["counts"] };
  deltas: Record<string, FinancialDelta>;
};
export type IntelligenceOrder = { id: string; capturedAt: string; status: string; provider: string; fulfillmentStatus: string; currencyCode: string; charged: number; merchandise: number | null; customerShipping: number | null; tax: number | null; refundReversal: number | null; netCollected: number | null; fulfillmentCost: number | null; processorFee: number | null; contributionMargin: number | null; completeness: string };
export type CommerceIntelligenceReport = {
  ok: true; environment: "live"; range: CommerceIntelligenceRange; generatedAt: string; timezone: "UTC"; currencyMode: "single" | "multiple";
  currencies: CurrencySummary[];
  trend: Array<{ currencyCode: string; bucket: string; merchandise: number; donations: number; refundsReversals: number; netCollected: number | null; complete: boolean }>;
  products: Array<{ productId: string; variantId: string | null; product: string; variant: string | null; currencyCode: string; quantity: number; grossMerchandise: number; refundedValue: number | null; netMerchandise: number | null; fulfillmentCost: number | null; costCoverage: { knownOrders: number; totalOrders: number }; complete: boolean }>;
  orders: { items: IntelligenceOrder[]; page: number; pageSize: number; total: number; totalPages: number; truncated: boolean };
  donations: Array<{ currencyCode: string; count: number; gross: number; refundsReversals: number | null; net: number | null; average: number; complete: boolean }>;
  refunds: Array<{ currencyCode: string; orderRefunds: number; fullOrderRefunds: number; partialOrderRefunds: number; refundValue: number | null; refundRate: number | null; refundRateBasis: string; donationRefunds: number; donationReversals: number; disputes: number; unresolvedDisputes: number }>;
  coverage: { orders: number; fulfillmentCost: { known: number; unknown: number }; processorFees: { known: number; unknown: number }; allocation: { complete: number; incomplete: number }; donationReversals: { complete: number; incomplete: number }; unresolvedDisputes: number; currencies: string[]; oldestTransactionAt: string | null; latestTransactionAt: string | null; latestFinancialUpdateAt: string | null; latestProviderUpdateAt: string | null; truncated: Record<string, boolean>; complete: boolean };
  semantics: Record<string, string>;
};

type ErrorPayload = { error?: string; message?: string };
export class CommerceIntelligenceError extends Error { code: string; status: number; constructor(message: string, code: string, status: number) { super(message); this.name = "CommerceIntelligenceError"; this.code = code; this.status = status; } }
export async function getCommerceIntelligence(range: CommerceIntelligenceRange, page = 1, pageSize = 20, signal?: AbortSignal) {
  const query = new URLSearchParams({ range, page: String(page), pageSize: String(pageSize) });
  const response = await fetch(`/api/admin/commerce/analytics?${query}`, { credentials: "include", cache: "no-store", signal, headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => null) as CommerceIntelligenceReport | ErrorPayload | null;
  if (!response.ok || !payload || !("ok" in payload)) throw new CommerceIntelligenceError((payload as ErrorPayload | null)?.message || "Commerce Intelligence is unavailable.", (payload as ErrorPayload | null)?.error || "commerce_intelligence_unavailable", response.status);
  return payload as CommerceIntelligenceReport;
}
