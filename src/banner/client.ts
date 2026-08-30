export type BannerMessage = { text: string; ctaLabel: string | null; href: string | null; newTab: boolean };
export type BannerConfig = {
  normal: { enabled: boolean; dismissible: boolean; messages: BannerMessage[]; mode: "static" | "ticker" | "crossfade"; speed: "slow" | "normal" | "fast"; glyph: "zap" | "arrow" | "diamond" | "dot"; glyphSize: "small" | "medium" | "large" };
  live: { enabled: boolean; label: string; showTitle: boolean; supportingText: string | null; ctaLabel: string; animation: "pulse" | "sweep" | "pulse-sweep" | "static"; intensity: "subtle" | "normal" | "strong" };
  homeRail: { enabled: boolean; items: string[]; mode: "marquee" | "crossfade" | "static"; speed: "slow" | "normal" | "fast"; easing: "linear" | "ease-in-out"; glyph: "zap" | "arrow" | "diamond" | "dot"; glyphSize: "small" | "medium" | "large" };
};
export type BannerSettings = { ok: true; config: BannerConfig; revision: number; updatedAt: string };

export async function readBannerSettings(): Promise<BannerSettings> {
  return request("GET");
}

export async function saveBannerSettings(config: BannerConfig, expectedRevision: number, csrfToken: string): Promise<BannerSettings> {
  return request("PUT", { config, expectedRevision }, csrfToken);
}

async function request(method: "GET" | "PUT", body?: unknown, csrfToken?: string): Promise<BannerSettings> {
  const response = await fetch("/api/admin/banner", {
    method,
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null) as (BannerSettings & { message?: string }) | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || "Banner configuration is unavailable.");
  return payload;
}
