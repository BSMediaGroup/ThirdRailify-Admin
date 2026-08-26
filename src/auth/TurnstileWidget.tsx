import { useEffect, useRef, useState } from "react";
type TurnstileApi = { render: (container: HTMLElement, options: Record<string, unknown>) => string; reset: (widgetId: string) => void; remove: (widgetId: string) => void };
declare global { interface Window { turnstile?: TurnstileApi; } }
let scriptPromise: Promise<TurnstileApi> | null = null;

export function TurnstileWidget({ siteKey, action, resetKey, onToken, onUnavailable }: { siteKey: string; action: string; resetKey: number; onToken: (token: string) => void; onUnavailable: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null); const widgetId = useRef(""); const [status, setStatus] = useState("Loading verification...");
  useEffect(() => {
    let active = true; setStatus("Loading verification...");
    loadTurnstile().then((api) => {
      if (!active || !container.current) return;
      widgetId.current = api.render(container.current, { sitekey: siteKey, action, theme: "dark",
        callback: (token: string) => { if (active) { onToken(token); setStatus(""); } },
        "expired-callback": () => { if (active) { onToken(""); setStatus("Verification expired. Complete it again."); } },
        "error-callback": () => { if (active) { onToken(""); setStatus(""); onUnavailable("Verification could not load. Try again."); window.setTimeout(() => container.current?.replaceChildren(), 0); } },
        "timeout-callback": () => { if (active) { onToken(""); setStatus("Verification timed out. Complete it again."); } },
      });
    }).catch(() => { if (active) onUnavailable("Verification is unavailable. Check your connection and try again."); });
    return () => { active = false; if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current); widgetId.current = ""; onToken(""); };
  }, [action, onToken, onUnavailable, siteKey]);
  useEffect(() => { if (widgetId.current && window.turnstile) { window.turnstile.reset(widgetId.current); onToken(""); } }, [onToken, resetKey]);
  return <div className="auth-turnstile"><div ref={container} />{status && <p role="status">{status}</p>}</div>;
}
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile); if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-thirdrailify-turnstile="true"]'); const script = existing || document.createElement("script");
    const timeout = window.setTimeout(() => reject(new Error("Turnstile timed out")), 12_000);
    const ready = () => { window.clearTimeout(timeout); if (window.turnstile) resolve(window.turnstile); else reject(new Error("Turnstile unavailable")); };
    script.addEventListener("load", ready, { once: true }); script.addEventListener("error", () => reject(new Error("Turnstile unavailable")), { once: true });
    if (!existing) { script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true; script.defer = true; script.dataset.thirdrailifyTurnstile = "true"; document.head.append(script); }
  }); return scriptPromise;
}
