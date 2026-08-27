export type WatchAdminEpisode = {
  id: string;
  identityKey: string;
  platform: "youtube" | "rumble";
  contentId: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  watchUrl: string;
  archiveDate: string;
  visible: boolean;
  archiveOrder: number;
  publicRoute: string;
};

export type WatchAdminPayload = {
  ok: true;
  current: null | {
    freshness: "fresh" | "delayed" | "stale";
    liveNow: Array<{ title: string; platform: string; presentationState: string }>;
    primary: null | { title: string; platform: string; presentationState: string; scheduledStart: string | null; actualStart: string | null; publishedAt: string | null };
    upcoming: null | { title: string; platform: string; scheduledStart: string | null };
  };
  summary: {
    retained: number;
    visible: number;
    hidden: number;
    remaining: number;
    newest: { id: string; title: string; date: string } | null;
    oldest: { id: string; title: string; date: string } | null;
  };
  episodes: WatchAdminEpisode[];
};

export type WatchAction = "read" | "show" | "hide" | "show_all" | "hide_all";

export async function manageWatch(action: WatchAction, csrfToken: string, episodeId?: string): Promise<WatchAdminPayload> {
  const body = episodeId ? { action, episodeId } : { action };
  const response = await fetch("/api/admin/watch", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (WatchAdminPayload & { message?: string }) | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || "The Watch archive service is unavailable.");
  return payload;
}
