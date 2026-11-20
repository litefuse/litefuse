import { z } from "zod/v4";

export const ssoLogoutUrlSchema = z.url().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return (
    (url.protocol === "https:" || localHttp) &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}, "Logout URL must use HTTPS (or local HTTP), without credentials or a fragment");

export const ssoLogoutConfigSchema = z
  .object({
    url: ssoLogoutUrlSchema,
    // Some endpoints require a hint; standard OIDC allows it to be omitted.
    requireIdToken: z.boolean().optional(),
    // Omit params to use standard OIDC names; provide a map to replace them.
    params: z
      .record(
        z.string().min(1),
        z.union([
          z.string(),
          z
            .object({
              source: z.enum(["clientId", "postLogoutRedirectUri", "idToken"]),
            })
            .strict(),
        ]),
      )
      .optional(),
  })
  .refine(
    (config) =>
      !config.requireIdToken ||
      !config.params ||
      Object.values(config.params).some(
        (value) => typeof value !== "string" && value.source === "idToken",
      ),
    {
      path: ["params"],
      message:
        "An ID token parameter is required when requireIdToken is enabled",
    },
  );

export type SsoLogoutConfig = z.infer<typeof ssoLogoutConfigSchema>;

// Zod validation schemas for each SSO provider.
// authProvider and authConfig field names follow NextAuth's standard conventions; field values are validated.

const baseSsoConfig = z.object({
  domain: z.string().refine((v) => v === v.toLowerCase(), {
    message: "Domain must be lowercase",
  }),
});

const tokenEndpointAuthMethod = z
  .enum([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
    "private_key_jwt",
    "tls_client_auth",
    "self_signed_tls_client_auth",
    "none",
  ])
  .optional();

const sharedOidcFields = {
  clientId: z.string(),
  clientSecret: z.string(),
  allowDangerousEmailAccountLinking: z.boolean().optional().default(false),
  tokenEndpointAuthMethod,
  logout: ssoLogoutConfigSchema.optional(),
};

export const googleSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("google"),
  authConfig: z.object(sharedOidcFields).nullish(),
});

export const githubSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("github"),
  authConfig: z.object(sharedOidcFields).nullish(),
});

export const githubEnterpriseSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("github-enterprise"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      enterprise: z.object({ baseUrl: z.string().url() }),
    })
    .nullish(),
});

export const gitlabSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("gitlab"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.string().optional(),
    })
    .nullish(),
});

export const auth0SsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("auth0"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.string(),
    })
    .nullish(),
});

export const oktaSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("okta"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.string().startsWith("https://", {
        message: "Okta issuer must start with https://",
      }),
    })
    .nullish(),
});

export const authentikSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("authentik"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.string().regex(/^https:\/\/.+\/application\/o\/[^/]+$/, {
        message:
          "Authentik issuer must be in format https://<domain>/application/o/<slug> without trailing slash",
      }),
    })
    .nullish(),
});

export const oneloginSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("onelogin"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.string(),
    })
    .nullish(),
});

export const azureAdSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("azure-ad"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      tenantId: z.string(),
    })
    .nullish(),
});

export const cognitoSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("cognito"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.string(),
    })
    .nullish(),
});

export const keycloakSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("keycloak"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      name: z.string().optional(),
      issuer: z.string(),
    })
    .nullish(),
});

export const customSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("custom"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      name: z.string(),
      issuer: z.string(),
      scope: z.string().nullish(),
      idToken: z.boolean().optional().default(false),
    })
    .nullish(),
});

export const jumpcloudSsoConfig = baseSsoConfig.extend({
  authProvider: z.literal("jumpcloud"),
  authConfig: z
    .object({
      ...sharedOidcFields,
      issuer: z.url(),
      scope: z.string().nullish(),
    })
    .nullish(),
});

export const ssoProviderSchema = z.discriminatedUnion("authProvider", [
  googleSsoConfig,
  githubSsoConfig,
  githubEnterpriseSsoConfig,
  gitlabSsoConfig,
  auth0SsoConfig,
  oktaSsoConfig,
  authentikSsoConfig,
  oneloginSsoConfig,
  azureAdSsoConfig,
  cognitoSsoConfig,
  keycloakSsoConfig,
  jumpcloudSsoConfig,
  customSsoConfig,
]);

export type SsoProviderConfig = z.infer<typeof ssoProviderSchema>;
