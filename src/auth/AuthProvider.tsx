import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createSiteTransfer, endSession, fetchAuthConfig, fetchSession, submitAuth, validatedSiteTransferUrl } from "./client";
import { AuthDialog } from "./AuthDialog";
import type { AuthAccount, AuthConfig, AuthMode, SessionPayload } from "./types";

type AuthContextValue = {
  loading: boolean; account: AuthAccount | null; config: AuthConfig | null; csrfToken: string; error: string;
  access: { isAdmin: boolean; isMasterAdmin: boolean };
  openAuth: (mode?: AuthMode) => void; closeAuth: () => void; applySession: (payload: SessionPayload) => Promise<void>;
  signOut: () => Promise<void>; refresh: () => Promise<void>; openPublicSite: (returnTo?: string, newTab?: boolean) => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
let startupRequest: Promise<{ config: AuthConfig; session: SessionPayload }> | null = null;
let startupSensitive: ReturnType<typeof takeSensitiveQuery> | null = null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [access, setAccess] = useState({ isAdmin: false, isMasterAdmin: false });
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; mode: AuthMode; resetToken: string }>({ open: false, mode: "signin", resetToken: "" });

  const setSession = useCallback((payload: SessionPayload) => {
    setAccount(payload.authenticated ? payload.account : null);
    setCsrfToken(payload.authenticated ? payload.csrfToken || "" : "");
    setAccess(payload.authenticated ? payload.access : { isAdmin: false, isMasterAdmin: false });
  }, []);

  useEffect(() => {
    let active = true;
    const sensitive = takeSensitiveQuery();
    if (!startupRequest) {
      startupSensitive = sensitive;
      startupRequest = Promise.all([
        fetchAuthConfig(),
        sensitive.handoff ? submitAuth("handoff", { code: sensitive.handoff }) : fetchSession(),
      ]).then(([nextConfig, session]) => ({ config: nextConfig, session }));
    }
    const initial = startupSensitive || sensitive;
    startupRequest.then(({ config: nextConfig, session }) => {
      if (!active) return;
      setConfig(nextConfig); setSession(session);
      if (initial.handoff && session.returnTo && session.returnTo !== window.location.pathname) window.location.assign(session.returnTo);
      if (initial.reset) setDialog({ open: true, mode: "reset", resetToken: initial.reset });
      if (initial.authError) { setError("The provider did not complete sign in. Try again."); setDialog({ open: true, mode: "signin", resetToken: "" }); }
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The account service is unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [setSession]);

  const refresh = useCallback(async () => setSession(await fetchSession()), [setSession]);
  const applySession = useCallback(async (payload: SessionPayload) => {
    if (payload.handoffCode) setSession(await submitAuth("handoff", { code: payload.handoffCode }));
    else setSession(payload);
    if (payload.authenticated || payload.handoffCode) setDialog((current) => ({ ...current, open: false }));
  }, [setSession]);
  const signOut = useCallback(async () => { if (csrfToken) setSession(await endSession(csrfToken)); }, [csrfToken, setSession]);
  const openPublicSite = useCallback(async (returnTo = "/", newTab = false) => {
    if (!csrfToken || !config?.publicOrigin) return;
    const destination = newTab ? window.open("about:blank", "_blank") : null;
    if (newTab && !destination) {
      setError("Allow pop-ups to open the Public site in a new tab.");
      return;
    }
    if (destination) destination.opener = null;
    try {
      const transfer = await createSiteTransfer(csrfToken, returnTo);
      const url = validatedSiteTransferUrl(transfer.handoffUrl, config.publicOrigin);
      if (destination) destination.location.replace(url);
      else window.location.assign(url);
    } catch (reason: unknown) {
      destination?.close();
      setError(reason instanceof Error ? reason.message : "The Public site handoff failed.");
    }
  }, [config, csrfToken]);
  const openAuth = useCallback((mode: AuthMode = "signin") => setDialog({ open: true, mode, resetToken: "" }), []);
  const closeAuth = useCallback(() => setDialog((current) => ({ ...current, open: false })), []);

  const value = useMemo<AuthContextValue>(() => ({ loading, account, config, csrfToken, error, access, openAuth, closeAuth, applySession, signOut, refresh, openPublicSite }), [access, account, applySession, closeAuth, config, csrfToken, error, loading, openAuth, openPublicSite, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}{dialog.open && <AuthDialog initialMode={dialog.mode} initialError={error} resetToken={dialog.resetToken} config={config} onClose={closeAuth} onSession={applySession} />}</AuthContext.Provider>;
}
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error("useAuth must be used inside AuthProvider"); return value; }

function takeSensitiveQuery() {
  const url = new URL(window.location.href);
  const handoff = url.searchParams.get("handoff") || ""; const reset = url.searchParams.get("reset") || ""; const authError = url.searchParams.get("auth_error") || "";
  for (const key of ["handoff", "reset", "auth_error", "return_to"]) url.searchParams.delete(key);
  if (handoff || reset || authError) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return { handoff, reset, authError };
}
