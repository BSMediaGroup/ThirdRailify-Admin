export type AuthIdentity = { provider: string; subject: string; username: string | null; email: string | null; emailVerified: boolean };
export type AuthAccount = {
  id: string; email: string | null; displayName: string; username: string | null; avatarUrl: string | null;
  providers: string[]; identities?: AuthIdentity[]; role: "user" | "admin"; adminLevel: "none" | "full" | "master";
  status: "pending_email" | "active" | "disabled"; emailVerified: boolean; emailVerifiedAt?: string | null;
  createdAt: string; updatedAt?: string; lastLoginAt: string | null; source: string; locked?: boolean;
  customer?: { id: string; orderCount: number; lastOrderAt: string | null } | null;
};
export type AuthConfig = {
  configured: boolean; emailSignupConfigured: boolean; turnstileSiteKey: string | null;
  oauthProviders: Array<{ id: "discord" | "google" | "github" | "twitter"; label: string }>;
  oauthProviderStates: Array<{
    id: "discord" | "google" | "github" | "twitter"; label: string;
    status: "enabled" | "disabled" | "unavailable"; message?: string;
  }>;
  publicOrigin: string | null; adminOrigin: string | null; environment: string; cookieMode: "host-only" | "shared-domain";
};
export type SessionPayload = {
  ok: boolean; authenticated: boolean; account: AuthAccount | null;
  access: { isAdmin: boolean; isMasterAdmin: boolean; capabilities?: string[] }; csrfToken?: string; handoffCode?: string;
  returnTo?: string; verificationPending?: boolean; message?: string;
};
export type AuthMode = "signin" | "signup" | "forgot" | "reset";
export class AuthClientError extends Error {
  code: string; status: number;
  constructor(status: number, code: string, message: string) { super(message); this.name = "AuthClientError"; this.status = status; this.code = code; }
}
