import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import boltMark from "../../assets/logos/boltv2straight.svg";
import discordIcon from "../../assets/icons/discord.svg";
import githubIcon from "../../assets/icons/github.svg";
import googleIcon from "../../assets/icons/google.svg";
import xIcon from "../../assets/icons/twitter.svg";
import { submitAuth, validatedAuthorizationUrl } from "./client";
import { TurnstileWidget } from "./TurnstileWidget";
import type { AuthConfig, AuthMode, SessionPayload } from "./types";

const providerIcons = { discord: discordIcon, google: googleIcon, github: githubIcon, twitter: xIcon };

export function AuthDialog({ initialMode, initialError, resetToken, config, onClose, onSession }: {
  initialMode: AuthMode; initialError: string; resetToken: string; config: AuthConfig | null;
  onClose: () => void; onSession: (payload: SessionPayload) => Promise<void>;
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [oauthProvider, setOauthProvider] = useState<AuthConfig["oauthProviders"][number] | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const initialField = useRef<HTMLInputElement>(null);
  const action = oauthProvider ? "thirdrailify-oauth" : mode === "signup" ? "thirdrailify-signup" : mode === "forgot" || mode === "reset" ? "thirdrailify-password-reset" : "thirdrailify-login";
  const configured = Boolean(config?.configured && config.turnstileSiteKey);

  useEffect(() => {
    initialField.current?.focus();
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", onKeyDown); };
  }, [busy, onClose]);

  const resetChallenge = useCallback(() => { setTurnstileToken(""); setResetKey((value) => value + 1); }, []);
  const acceptToken = useCallback((token: string) => setTurnstileToken(token), []);
  const verificationUnavailable = useCallback((value: string) => setError(value), []);
  const visibleProviders = useMemo(() => (
    config?.oauthProviderStates
    ?? config?.oauthProviders.map((provider) => ({ ...provider, status: "enabled" as const }))
    ?? []
  ).filter((provider) => provider.status !== "unavailable"), [config]);
  const switchMode = (nextMode: AuthMode) => { setMode(nextMode); setOauthProvider(null); setError(""); setMessage(""); resetChallenge(); };
  const heading = useMemo(() => oauthProvider ? `Continue with ${oauthProvider.label}` : mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : mode === "reset" ? "Choose a new password" : "Control room sign in", [mode, oauthProvider]);

  const startOAuth = async () => {
    if (!oauthProvider || !turnstileToken) { setError("Complete verification before continuing to the provider."); return; }
    setBusy(true); setError("");
    try {
      const payload = await submitAuth(`oauth/${oauthProvider.id}/start`, { turnstileToken, returnTo: returnPath() });
      window.location.assign(validatedAuthorizationUrl(String(payload.authorizationUrl || "")));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider sign in could not start."); resetChallenge(); setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!turnstileToken) { setError("Complete verification before continuing."); return; }
    const values = new FormData(event.currentTarget); const password = String(values.get("password") || ""); const confirmation = String(values.get("confirmPassword") || "");
    if ((mode === "signup" || mode === "reset") && password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const path = mode === "signup" ? "signup" : mode === "forgot" ? "password/forgot" : mode === "reset" ? "password/reset" : "login";
      const payload = await submitAuth(path, { email: String(values.get("email") || ""), displayName: String(values.get("displayName") || ""), password, token: mode === "reset" ? resetToken : undefined, turnstileToken, returnTo: returnPath() });
      if (payload.verificationPending || mode === "forgot") { setMessage(payload.message || "Check your email to continue."); resetChallenge(); }
      else await onSession(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The account request failed."); resetChallenge(); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialog} className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title" aria-describedby="auth-intro">
        <button className="auth-dialog__close" type="button" onClick={onClose} disabled={busy} aria-label="Close account dialog">&#215;</button>
        <header className="auth-dialog__header"><img src={boltMark} alt="" /><div><span>Third Railify account</span><h2 id="auth-title">{heading}</h2></div></header>
        <p id="auth-intro" className="auth-dialog__intro">Authenticate with the shared account authority. Admin access is resolved by the server after sign in.</p>
        {!configured && <div className="auth-alert" role="alert">Account sign-in is not configured for this environment.</div>}
        {error && <div className="auth-alert" role="alert">{error}</div>}
        {message && <div className="auth-success" role="status">{message}</div>}
        {configured && !message && oauthProvider && <section className="auth-oauth-step">
          <button className="auth-back" type="button" onClick={() => { setOauthProvider(null); resetChallenge(); }} disabled={busy}>Back to sign in</button>
          <div className="auth-provider auth-provider--selected"><img src={providerIcons[oauthProvider.id]} alt="" /><span>{oauthProvider.label}</span></div>
          <TurnstileWidget siteKey={config!.turnstileSiteKey!} action={action} resetKey={resetKey} onToken={acceptToken} onUnavailable={verificationUnavailable} />
          <button className="auth-primary" type="button" onClick={startOAuth} disabled={busy || !turnstileToken}>{busy ? "Connecting..." : `Continue with ${oauthProvider.label}`}</button>
        </section>}
        {configured && !message && !oauthProvider && <>
          {(mode === "signin" || mode === "signup") && visibleProviders.length > 0 && <div className="auth-providers" aria-label="Provider sign in options">{visibleProviders.map((provider) => <button key={provider.id} type="button" className={`auth-provider${provider.status === "disabled" ? " auth-provider--disabled" : ""}`} disabled={provider.status !== "enabled"} aria-describedby={provider.status === "disabled" ? `auth-provider-${provider.id}-status` : undefined} title={provider.status === "disabled" ? provider.message : undefined} onClick={() => { if (provider.status !== "enabled") return; setOauthProvider(provider); setError(""); resetChallenge(); }}><img src={providerIcons[provider.id]} alt="" /><span className="auth-provider__copy"><span>Continue with {provider.label}</span>{provider.status === "disabled" && <small id={`auth-provider-${provider.id}-status`}>{provider.message || "Currently unavailable"}</small>}</span></button>)}</div>}
          {(mode === "signin" || mode === "signup") && visibleProviders.length > 0 && <div className="auth-divider"><span>or use email</span></div>}
          <form className="auth-form" onSubmit={submit}>
            {(mode === "signin" || mode === "signup") && <div className="auth-mode-tabs" role="group" aria-label="Account mode"><button type="button" aria-pressed={mode === "signin"} onClick={() => switchMode("signin")}>Sign in</button>{config!.emailSignupConfigured && <button type="button" aria-pressed={mode === "signup"} onClick={() => switchMode("signup")}>Create account</button>}</div>}
            {mode === "signup" && <AuthField ref={initialField} label="Display name" name="displayName" autoComplete="name" minLength={2} />}
            {mode !== "reset" && <AuthField ref={mode === "signup" ? undefined : initialField} label="Email" name="email" type="email" autoComplete="email" />}
            {mode !== "forgot" && <label className="auth-field"><span>Password</span><span className="auth-password"><input ref={mode === "reset" ? initialField : undefined} name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={mode === "signin" ? undefined : 12} maxLength={256} required /><button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button></span></label>}
            {(mode === "signup" || mode === "reset") && <AuthField label="Confirm password" name="confirmPassword" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={256} />}
            {mode === "signin" && config!.emailSignupConfigured && <button className="auth-text-button" type="button" onClick={() => switchMode("forgot")}>Forgot password?</button>}
            <TurnstileWidget siteKey={config!.turnstileSiteKey!} action={action} resetKey={resetKey} onToken={acceptToken} onUnavailable={verificationUnavailable} />
            <button className="auth-primary" type="submit" disabled={busy || !turnstileToken}>{busy ? "Working..." : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : mode === "reset" ? "Set new password" : "Sign in"}</button>
            {(mode === "forgot" || mode === "reset") && <button className="auth-text-button" type="button" onClick={() => switchMode("signin")}>Back to sign in</button>}
          </form>
        </>}
        <footer className="auth-dialog__footer">By continuing, you agree to the <a href="https://thirdrailify.com/terms">Terms</a> and acknowledge the <a href="https://thirdrailify.com/privacy">Privacy Policy</a>.</footer>
      </div>
    </div>
  );
}

const AuthField = forwardRef<HTMLInputElement, { label: string; name: string } & InputHTMLAttributes<HTMLInputElement>>(function AuthField({ label, name, ...props }, ref) { return <label className="auth-field"><span>{label}</span><input ref={ref} name={name} required {...props} /></label>; });
function returnPath() { const path = window.location.pathname; return path.startsWith("/api/") ? "/" : path; }
