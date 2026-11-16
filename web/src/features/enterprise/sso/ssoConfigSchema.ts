import { z } from "zod/v4";

// Validation schemas for the SSO providers Litefuse supports.
//
// Provider ids, the `authProvider` union tag and the config field names are
// protocol facts shared with NextAuth and the identity providers themselves, so
// their values are fixed here. Only the validation code around them is ours.

const isLowercase = (domain: string): boolean =>
  domain === domain.toLowerCase();

const domainField = z.string().refine(isLowercase, {
  message: "Domains must be written in lowercase",
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

const emailAccountLinking = z.boolean().optional().default(false);

/** Config fields carried by every OAuth/OIDC provider. */
const oidcFields = {
  clientId: z.string(),
  clientSecret: z.string(),
  allowDangerousEmailAccountLinking: emailAccountLinking,
  tokenEndpointAuthMethod,
};

/**
 * Assemble the schema of one SSO provider variant: the shared lowercase domain,
 * the provider id as the discriminated-union tag, and that provider's own auth
 * config — optional, since a domain may also fall back to the global social
 * login credentials.
 */
const defineProvider = <Tag extends string, Fields extends z.ZodRawShape>(
  authProvider: Tag,
  fields: Fields,
) =>
  z.object({
    domain: domainField,
    authProvider: z.literal(authProvider),
    authConfig: z.object(fields).nullish(),
  });

export const googleSsoConfig = defineProvider("google", oidcFields);

export const githubSsoConfig = defineProvider("github", oidcFields);

export const githubEnterpriseSsoConfig = defineProvider("github-enterprise", {
  ...oidcFields,
  enterprise: z.object({ baseUrl: z.string().url() }),
});

export const gitlabSsoConfig = defineProvider("gitlab", {
  ...oidcFields,
  issuer: z.string().optional(),
});

export const auth0SsoConfig = defineProvider("auth0", {
  ...oidcFields,
  issuer: z.string(),
});

export const oktaSsoConfig = defineProvider("okta", {
  ...oidcFields,
  issuer: z.string().startsWith("https://", {
    message: "Okta issuer must start with https://",
  }),
});

export const authentikSsoConfig = defineProvider("authentik", {
  ...oidcFields,
  issuer: z.string().regex(/^https:\/\/.+\/application\/o\/[^/]+$/, {
    message:
      "Authentik issuer must look like https://<domain>/application/o/<slug> with no trailing slash",
  }),
});

export const oneloginSsoConfig = defineProvider("onelogin", {
  ...oidcFields,
  issuer: z.string(),
});

export const azureAdSsoConfig = defineProvider("azure-ad", {
  ...oidcFields,
  tenantId: z.string(),
});

export const cognitoSsoConfig = defineProvider("cognito", {
  ...oidcFields,
  issuer: z.string(),
});

export const keycloakSsoConfig = defineProvider("keycloak", {
  ...oidcFields,
  name: z.string().optional(),
  issuer: z.string(),
});

export const customSsoConfig = defineProvider("custom", {
  ...oidcFields,
  name: z.string(),
  issuer: z.string(),
  scope: z.string().nullish(),
  idToken: z.boolean().optional().default(false),
});

export const jumpcloudSsoConfig = defineProvider("jumpcloud", {
  ...oidcFields,
  issuer: z.url(),
  scope: z.string().nullish(),
});

const providerVariants = [
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
] as const;

export const ssoProviderSchema = z.discriminatedUnion(
  "authProvider",
  providerVariants,
);

export type SsoProviderConfig = z.infer<typeof ssoProviderSchema>;
