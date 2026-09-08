import { useEffect, useRef, useState } from "react";
type TurnstileApi = { render: (container: HTMLElement, options: Record<string, unknown>) => string; reset: (widgetId: string) => void; remove: (widgetId: string) => void };
declare global { interface Window { turnstile?: TurnstileApi; } }
let scriptPromise: Promise<TurnstileApi> | null = null;

export function TurnstileWidget({ siteKey, action, resetKey, onToken, onUnavailable }: { siteKey: string; action: string; resetKey: number; onToken: (token: string) => void; onUnavailable: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null); const widgetId = useRef(""); const [status, setStatus] = useState("Loading verification...");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setFailed(false); setStatus("Loading verification...");
    loadTurnstile().then((api) => {
      if (!active || !container.current) return;
      widgetId.current = api.render(container.current, { sitekey: siteKey, action, theme: "dark",
        callback: (token: string) => { if (active) { onToken(token); setStatus(""); setFailed(false); onUnavailable(""); } },
        "expired-callback": () => { if (active) { onToken(""); setStatus("Verification expired. Complete it again."); } },
        "error-callback": (code: string) => { if (active) { onToken(""); setFailed(true); setStatus(`Verification error ${code}. Retry verification below.`); onUnavailable("Verification could not complete. Retry verification."); } },
        "timeout-callback": () => { if (active) { onToken(""); setStatus("Verification timed out. Complete it again."); } },
      });
    }).catch(() => { if (active) { setFailed(true); setStatus("Verification could not load."); onUnavailable("Verification is unavailable. Check your connection and retry verification."); } });
    return () => { active = false; if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current); widgetId.current = ""; onToken(""); };
  }, [action, onToken, onUnavailable, siteKey, retry]);
  useEffect(() => { if (widgetId.current && window.turnstile) { window.turnstile.reset(widgetId.current); onToken(""); } }, [onToken, resetKey]);
  return <div className="auth-turnstile"><div ref={container} />{status && <p role="status">{status}</p>}{failed && <button type="button" onClick={() => { onUnavailable(""); setRetry(value => value + 1); }}>Retry verification</button>}</div>;
}
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-thirdrailify-turnstile="true"]');
    const script = existing || document.createElement("script");
    const cleanup = () => { window.clearTimeout(timeout); script.removeEventListener("load", ready); script.removeEventListener("error", failed); };
    const failed = () => { cleanup(); script.remove(); reject(new Error("Turnstile unavailable")); };
    const ready = () => { if (!window.turnstile) { failed(); return; } cleanup(); resolve(window.turnstile); };
    const timeout = window.setTimeout(failed, 12_000);
    script.addEventListener("load", ready, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true; script.defer = true; script.dataset.thirdrailifyTurnstile = "true";
      document.head.append(script);
    }
  }).catch(error => { scriptPromise = null; throw error; });
  return scriptPromise;
}
