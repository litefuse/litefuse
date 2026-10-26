import { type Provider } from "next-auth/providers/index";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import GitLabProvider from "next-auth/providers/gitlab";
import OktaProvider from "next-auth/providers/okta";
import AuthentikProvider from "next-auth/providers/authentik";
import OneLoginProvider from "next-auth/providers/onelogin";
import CognitoProvider from "next-auth/providers/cognito";
import KeycloakProvider from "next-auth/providers/keycloak";
import Auth0Provider from "next-auth/providers/auth0";
import AzureADProvider from "next-auth/providers/azure-ad";
import { prisma, type SsoConfig } from "@langfuse/shared/src/db";
import { decrypt } from "@langfuse/shared/encryption";
import {
  CustomSSOProvider,
  GitHubEnterpriseProvider,
  JumpCloudProvider,
  logger,
  traceException,
} from "@langfuse/shared/src/server";
import { isMultiTenantSsoAvailable } from "@/src/features/auth/sso/isMultiTenantSsoAvailable";
import {
  ssoProviderSchema,
  type SsoProviderConfig,
} from "@/src/features/enterprise/sso/ssoConfigSchema";

type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "client_secret_jwt"
  | "private_key_jwt"
  | "tls_client_auth"
  | "self_signed_tls_client_auth"
  | "none";

/** Credentials of a parsed SSO config, i.e. what the IdP is configured with. */
type ProviderAuthConfig = NonNullable<SsoProviderConfig["authConfig"]>;

/** NextAuth expects the token endpoint auth method under a `client` key. */
type ClientConfig =
  | { client: { token_endpoint_auth_method: TokenEndpointAuthMethod } }
  | Record<string, never>;

// Local cache of SSO configs
let ssoConfigCache: {
  data: SsoProviderConfig[];
  failedToFetch: boolean;
  timestamp: number;
} = { data: [], failedToFetch: false, timestamp: 0 };

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const FAILED_RETRY_AFTER = 60 * 1000; // 1 minute
const DB_MAX_WAIT = 5 * 1000;
const DB_TIMEOUT = 5 * 1000;

/**
 * Read the SSO configs from the database and parse them into schema objects,
 * serving the local cache while it is still fresh. Rows that no longer match
 * the schema are skipped instead of failing the whole lookup.
 */
async function loadSsoConfigs(): Promise<SsoProviderConfig[]> {
  if (!isMultiTenantSsoAvailable) return [];

  const retryAfter = ssoConfigCache.failedToFetch
    ? FAILED_RETRY_AFTER
    : CACHE_TTL;
  const cacheIsStale = Date.now() - ssoConfigCache.timestamp > retryAfter;

  if (cacheIsStale) {
    let dbConfigs: SsoConfig[] = [];
    let failedToFetch = false;
    try {
      dbConfigs = await prisma.$transaction(
        async (tx) => tx.ssoConfig.findMany(),
        { maxWait: DB_MAX_WAIT, timeout: DB_TIMEOUT },
      );
    } catch (e) {
      logger.error("Unable to read the SSO configs from the database", e);
      traceException(e);
      // The empty result is cached so an unreachable database is not retried
      // on every request.
      failedToFetch = true;
    }

    const parsed = dbConfigs
      .map((row) => {
        try {
          return ssoProviderSchema.parse(row);
        } catch (e) {
          logger.error(
            `Skipping SSO config of domain ${row.domain}: invalid schema`,
            e,
          );
          traceException(e);
          return null;
        }
      })
      .filter((config): config is SsoProviderConfig => config !== null);

    ssoConfigCache = {
      data: parsed,
      timestamp: Date.now(),
      failedToFetch,
    };
  }

  return ssoConfigCache.data;
}

/**
 * Build the NextAuth providers list (used by the auth config).
 */
export async function buildSsoProviders(): Promise<Provider[]> {
  if (!isMultiTenantSsoAvailable) return [];

  const configs = await loadSsoConfigs();

  return configs
    .map((config) => toNextAuthProvider(config))
    .filter((provider): provider is Provider => provider !== null);
}

/**
 * Whether any custom SSO is configured.
 */
export async function hasSsoConfig(): Promise<boolean> {
  if (!isMultiTenantSsoAvailable) return false;
  return (await loadSsoConfigs()).length > 0;
}

/**
 * Look up the SSO providerId for a domain (used by signIn(providerId)).
 */
export async function resolveSsoProviderIdForDomain(
  domain: string,
): Promise<string | null> {
  if (!isMultiTenantSsoAvailable) return null;
  const config = (await loadSsoConfigs()).find(
    (candidate) => candidate.domain === domain.toLowerCase(),
  );
  if (!config) return null;
  return buildAuthProviderId(config);
}

/**
 * Build the providerId for a custom SSO config (domain.authProvider).
 */
const buildAuthProviderId = (config: SsoProviderConfig): string => {
  if (!config.authConfig) return config.authProvider;
  return `${config.domain}.${config.authProvider}`;
};

/**
 * Build the NextAuth client config for the given token endpoint auth method.
 */
const toClientConfig = (authConfig: ProviderAuthConfig): ClientConfig => {
  const method = authConfig.tokenEndpointAuthMethod;
  if (!method) return {};
  return { client: { token_endpoint_auth_method: method } };
};

/**
 * Convert a database SSO config into a NextAuth Provider instance.
 * Returns null for configs without custom credentials (they fall back to the global social login).
 */
const toNextAuthProvider = (config: SsoProviderConfig): Provider | null => {
  if (!config.authConfig) return null;

  const providerId = buildAuthProviderId(config);
  const clientConfig = toClientConfig(config.authConfig);
  const clientSecret = decrypt(config.authConfig.clientSecret);

  switch (config.authProvider) {
    case "google":
      return GoogleProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "github":
      return GitHubProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "gitlab":
      return GitLabProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "auth0":
      return Auth0Provider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "okta":
      return OktaProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "authentik":
      return AuthentikProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "onelogin":
      return OneLoginProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "azure-ad":
      return AzureADProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "cognito":
      return CognitoProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "keycloak":
      return KeycloakProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        ...clientConfig,
      });
    case "custom":
      return CustomSSOProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        authorization: {
          params: {
            scope: config.authConfig.scope ?? "openid email profile",
          },
        },
        ...clientConfig,
      });
    case "github-enterprise":
      return GitHubEnterpriseProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        enterprise: {
          baseUrl: config.authConfig.enterprise.baseUrl,
        },
        ...clientConfig,
      });
    case "jumpcloud":
      return JumpCloudProvider({
        id: providerId,
        ...config.authConfig,
        clientSecret,
        authorization: {
          params: {
            scope: config.authConfig.scope ?? "openid email profile",
          },
        },
        ...clientConfig,
      });
    default: {
      const exhaustive: never = config;
      logger.error(
        `Unrecognized SSO provider for domain ${(exhaustive as unknown as { domain: string }).domain}`,
      );
      traceException(
        new Error(
          `Unrecognized SSO provider for domain ${(exhaustive as unknown as { domain: string }).domain}`,
        ),
      );
      return null;
    }
  }
};

/**
 * Look up a multi-tenant SSO config by providerId (used by the sign-in flow).
 */
export const resolveMultiTenantSsoConfig = async ({
  providerId,
}: {
  providerId: string;
}): Promise<
  | { isMultiTenantSsoProvider: true; domain: string }
  | { isMultiTenantSsoProvider: false; domain: null }
> => {
  const configs = await loadSsoConfigs();
  const matched = configs
    .filter((config) => Boolean(config.authConfig))
    .find((config) => buildAuthProviderId(config) === providerId);

  return matched
    ? { isMultiTenantSsoProvider: true, domain: matched.domain }
    : { isMultiTenantSsoProvider: false, domain: null };
};
