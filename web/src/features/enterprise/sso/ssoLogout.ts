import { createHash } from "node:crypto";
import { type Account } from "next-auth";
import { type JWT } from "next-auth/jwt";
import { type Provider } from "next-auth/providers/index";
import { ssoLogoutConfigSchema, type SsoLogoutConfig } from "./ssoConfigSchema";

type SsoLoginIdentity = {
  clientId?: string;
  issuer?: string;
  tenantId?: string;
  enterprise?: { baseUrl: string };
};

export function getSsoLogoutBinding(
  providerId: string,
  config: SsoLoginIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        providerId,
        config.clientId,
        config.issuer,
        config.tenantId,
        config.enterprise?.baseUrl,
      ]),
    )
    .digest("hex");
}

export function logoutUsesIdToken(logout: SsoLogoutConfig): boolean {
  return (
    !logout.params ||
    Object.values(logout.params).some(
      (param) => typeof param !== "string" && param.source === "idToken",
    )
  );
}

// Leave room for NextAuth's timestamps/JWE envelope and the cookie name/options,
// keeping the augmented session within one 4 KiB cookie rather than chunking it.
const MAX_SESSION_PAYLOAD_BYTES = 2500;

/** Keep provider identity in the encrypted JWT, never in the public session response. */
export async function rememberSsoSession({
  token,
  account,
  providers = [],
}: {
  token: JWT;
  account?: Account | null;
  providers?: Provider[];
}): Promise<JWT> {
  // Session reads and client-triggered updates must not overwrite the login identity.
  // Legacy sessions remain valid; their next real login records the SSO provider.
  if (!account) return token;

  token.ssoProviderId = account.provider;
  delete token.ssoIdToken;
  delete token.ssoLogoutBinding;
  delete token.ssoLogoutError;

  // Use the provider snapshot that handled this login, without another cache/DB lookup.
  const provider = providers.find(
    (item) => (item.options?.id ?? item.id) === account.provider,
  );
  const options = provider?.options as
    | (SsoLoginIdentity & { logout?: unknown })
    | undefined;
  if (!options) return token;
  token.ssoLogoutBinding = getSsoLogoutBinding(account.provider, options);
  const logout = ssoLogoutConfigSchema.safeParse(options.logout);
  if (!logout.success || !logoutUsesIdToken(logout.data) || !account.id_token)
    return token;

  token.ssoIdToken = account.id_token;
  if (
    Buffer.byteLength(JSON.stringify(token), "utf8") > MAX_SESSION_PAYLOAD_BYTES
  ) {
    delete token.ssoIdToken;
    token.ssoLogoutError = "id_token_too_large";
  }
  return token;
}

export function createSsoLogoutUrl({
  clientId,
  logout,
  returnTo,
  idToken,
}: {
  clientId: string;
  logout: SsoLogoutConfig;
  returnTo: string;
  idToken?: string;
}): string {
  const url = new URL(logout.url);
  const values = { clientId, postLogoutRedirectUri: returnTo, idToken };
  const params: NonNullable<SsoLogoutConfig["params"]> = logout.params ?? {
    client_id: { source: "clientId" },
    post_logout_redirect_uri: { source: "postLogoutRedirectUri" },
    id_token_hint: { source: "idToken" },
  };
  for (const [name, parameter] of Object.entries(params)) {
    const value =
      typeof parameter === "string" ? parameter : values[parameter.source];
    // Do not reuse a stale token from a configured URL if this login has no ID token.
    url.searchParams.delete(name);
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}
