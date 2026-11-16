/**
 * Characterisation tests for `ssoConfigSchema.ts` (batch 3a, cases D1-D14 of
 * docs/ee-independence/03-auth-sso/spec.md §12.4).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * This module is a pure zod module, so there is no HTTP or database surface:
 * everything is asserted through `ssoProviderSchema.safeParse` and through the
 * 13 per-provider schemas. Only public exports are touched.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS FROZEN HERE (spec §5, §0.1)
 * ---------------------------------------------------------------------------
 * The provider id set and the order of the discriminated-union members, the
 * field names and their required/optional/default status, and the two literal
 * validation messages. Wording of anything else is free.
 *
 * ---------------------------------------------------------------------------
 * KNOWN PRODUCT DECISIONS / RESIDUALS (spec §16, §K.1b) -- NOT to be "fixed"
 * ---------------------------------------------------------------------------
 * - `loadSsoConfigs` (spec §6.1) is deliberately fail-OPEN: a failed read, or a
 *   single row that no longer matches this schema, silently drops the SSO
 *   enforcement for the affected domains for up to 60 seconds. The product owner
 *   decided (spec §K.1b) to keep that over a fail-closed read, to avoid locking
 *   out users of unregistered domains during a database hiccup. Nothing in this
 *   file asserts fail-closed behaviour.
 * - `jumpcloudSsoConfig` uses `z.url()` while every other OIDC provider uses
 *   `z.string()` (spec §5). That asymmetry is pinned by D10 rather than treated
 *   as a defect.
 * - The dynamic-import module specifier used by the gateway ("@/src/features/
 *   enterprise/sso/ssoProviders") is validated as a non-empty promise by the
 *   export-surface check in `src/__tests__/server/auth-sso-api.servertest.ts`
 *   (case X2). It cannot be resolved at runtime here: jsdom cannot load the
 *   shared server barrel (undici's `MessagePort`) -- see
 *   `src/features/auth/sso/enterpriseSsoInterop.clienttest.ts` for the details.
 */

import { z } from "zod/v4";
import {
  auth0SsoConfig,
  authentikSsoConfig,
  azureAdSsoConfig,
  cognitoSsoConfig,
  customSsoConfig,
  gitlabSsoConfig,
  githubEnterpriseSsoConfig,
  githubSsoConfig,
  googleSsoConfig,
  jumpcloudSsoConfig,
  keycloakSsoConfig,
  oktaSsoConfig,
  oneloginSsoConfig,
  ssoProviderSchema,
} from "@/src/features/enterprise/sso/ssoConfigSchema";

/** Smallest valid `authConfig` for an OIDC provider. */
const oidc = { clientId: "cid", clientSecret: "csecret" };

/** Tag -> minimal valid authConfig for that provider. */
const minimalAuthConfigs: Record<string, Record<string, unknown>> = {
  google: oidc,
  github: oidc,
  "github-enterprise": {
    ...oidc,
    enterprise: { baseUrl: "https://github.example.com" },
  },
  gitlab: oidc,
  auth0: { ...oidc, issuer: "https://tenant.auth0.com" },
  okta: { ...oidc, issuer: "https://tenant.okta.com" },
  authentik: {
    ...oidc,
    issuer: "https://authentik.example.com/application/o/app",
  },
  onelogin: { ...oidc, issuer: "https://tenant.onelogin.com" },
  "azure-ad": { ...oidc, tenantId: "tenant-id" },
  cognito: {
    ...oidc,
    issuer: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_x",
  },
  keycloak: { ...oidc, issuer: "https://keycloak.example.com/realms/main" },
  jumpcloud: { ...oidc, issuer: "https://console.jumpcloud.com" },
  custom: {
    ...oidc,
    name: "Custom",
    issuer: "https://idp.example.com",
  },
};

const describeIssue = (issue: z.core.$ZodIssue) => ({
  code: issue.code,
  path: issue.path,
  message: issue.message,
});

describe("ssoConfigSchema characterisation (D1-D14)", () => {
  // D1
  it("D1 accepts the 13 provider ids, each with its minimal valid config", () => {
    const tags = Object.keys(minimalAuthConfigs);
    expect(tags).toHaveLength(13);

    for (const authProvider of tags) {
      const result = ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider,
        authConfig: minimalAuthConfigs[authProvider],
      });
      expect({
        authProvider,
        success: result.success,
        issues: result.success ? [] : result.error.issues,
      }).toEqual({ authProvider, success: true, issues: [] });
      if (result.success) {
        expect(result.data.authProvider).toBe(authProvider);
      }
    }
  });

  // D2
  it("D2 rejects an uppercase domain with the exact message", () => {
    const result = ssoProviderSchema.safeParse({
      domain: "Ok.com",
      authProvider: "google",
      authConfig: oidc,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(describeIssue)).toEqual([
        {
          code: "custom",
          path: ["domain"],
          message: "Domains must be written in lowercase",
        },
      ]);
    }
  });

  // D2 (control): no trim, no dot requirement -- only lowercase is validated
  it("D2 accepts lowercase domains with no dot and rejects whitespace-carrying uppercase", () => {
    expect(
      ssoProviderSchema.safeParse({
        domain: "localhost",
        authProvider: "google",
        authConfig: oidc,
      }).success,
    ).toBe(true);
    // " acme.test" is already lowercase, so the lowercase refine passes and the
    // value is kept verbatim (no trim).
    const spaced = ssoProviderSchema.safeParse({
      domain: " acme.test",
      authProvider: "google",
      authConfig: oidc,
    });
    expect(spaced.success).toBe(true);
    if (spaced.success) expect(spaced.data.domain).toBe(" acme.test");
  });

  // D3
  it("D3 accepts a missing and a null authConfig, preserving the difference", () => {
    const missing = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "okta",
    });
    expect(missing.success).toBe(true);
    if (missing.success) {
      expect("authConfig" in missing.data).toBe(false);
      expect(missing.data.authConfig).toBeUndefined();
    }

    const nulled = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "okta",
      authConfig: null,
    });
    expect(nulled.success).toBe(true);
    if (nulled.success) expect(nulled.data.authConfig).toBeNull();
  });

  // D4
  it("D4 fills the defaults when authConfig is an object", () => {
    const okta = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "okta",
      authConfig: { ...oidc, issuer: "https://tenant.okta.com" },
    });
    expect(okta.success).toBe(true);
    if (okta.success) {
      expect(okta.data.authConfig?.allowDangerousEmailAccountLinking).toBe(
        false,
      );
    }

    const custom = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "custom",
      authConfig: {
        ...oidc,
        name: "Custom",
        issuer: "https://idp.example.com",
      },
    });
    expect(custom.success).toBe(true);
    if (custom.success) {
      expect(custom.data.authConfig?.allowDangerousEmailAccountLinking).toBe(
        false,
      );
      if (custom.data.authProvider === "custom") {
        expect(custom.data.authConfig?.idToken).toBe(false);
      }
    }
  });

  // D5
  it("D5 drops unknown top-level and authConfig keys without failing", () => {
    const result = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "google",
      authConfig: { ...oidc, unexpectedProviderField: "x" },
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      unrelated: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual([
        "authConfig",
        "authProvider",
        "domain",
      ]);
      expect(Object.keys(result.data.authConfig ?? {}).sort()).toEqual([
        "allowDangerousEmailAccountLinking",
        "clientId",
        "clientSecret",
      ]);
    }
  });

  // D6
  it("D6 rejects a non-https Okta issuer with the exact message", () => {
    const result = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "okta",
      authConfig: { ...oidc, issuer: "http://x" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Okta issuer must start with https://",
      );
    }
  });

  // D7
  it("D7 rejects an Authentik issuer with a trailing slash with the exact message", () => {
    const result = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "authentik",
      authConfig: {
        ...oidc,
        issuer: "https://authentik.example.com/application/o/app/",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "Authentik issuer must look like https://<domain>/application/o/<slug> with no trailing slash",
      );
    }
    // Control: the same issuer without the trailing slash is accepted.
    expect(
      ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider: "authentik",
        authConfig: {
          ...oidc,
          issuer: "https://authentik.example.com/application/o/app",
        },
      }).success,
    ).toBe(true);
  });

  // D8
  it("D8 rejects a non-URL github-enterprise baseUrl", () => {
    const result = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "github-enterprise",
      authConfig: { ...oidc, enterprise: { baseUrl: "not-a-url" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("baseUrl"))).toBe(
        true,
      );
    }
  });

  // D9
  it("D9 rejects azure-ad without a tenantId", () => {
    const result = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "azure-ad",
      authConfig: oidc,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("tenantId"))).toBe(
        true,
      );
    }
  });

  // D10
  it("D10 enforces custom.name/issuer and the jumpcloud issuer URL shape", () => {
    for (const missing of ["name", "issuer"] as const) {
      const authConfig: Record<string, unknown> = {
        ...oidc,
        name: "Custom",
        issuer: "https://idp.example.com",
      };
      delete authConfig[missing];
      expect({
        missingField: missing,
        success: ssoProviderSchema.safeParse({
          domain: "acme.test",
          authProvider: "custom",
          authConfig,
        }).success,
      }).toEqual({ missingField: missing, success: false });
    }

    // jumpcloud is the one provider whose issuer is validated as a URL.
    expect(
      ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider: "jumpcloud",
        authConfig: { ...oidc, issuer: "not-a-url" },
      }).success,
    ).toBe(false);
    // A bare string issuer is fine everywhere else (D13 control for gitlab).
    expect(
      ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider: "gitlab",
        authConfig: { ...oidc, issuer: "not-a-url" },
      }).success,
    ).toBe(true);
  });

  // D11
  it("D11 accepts the 7 token endpoint auth methods and rejects anything else", () => {
    const methods = [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
      "tls_client_auth",
      "self_signed_tls_client_auth",
      "none",
    ] as const;
    for (const tokenEndpointAuthMethod of methods) {
      const result = ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider: "google",
        authConfig: { ...oidc, tokenEndpointAuthMethod },
      });
      expect({ tokenEndpointAuthMethod, success: result.success }).toEqual({
        tokenEndpointAuthMethod,
        success: true,
      });
      if (result.success) {
        expect(result.data.authConfig?.tokenEndpointAuthMethod).toBe(
          tokenEndpointAuthMethod,
        );
      }
    }

    expect(
      ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider: "google",
        authConfig: { ...oidc, tokenEndpointAuthMethod: "bogus" },
      }).success,
    ).toBe(false);
  });

  // D12
  it("D12 reports a single invalid_union issue on authProvider for unknown or missing discriminators", () => {
    const unknown = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authProvider: "nope",
      authConfig: oidc,
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues).toHaveLength(1);
      expect(describeIssue(unknown.error.issues[0])).toEqual({
        code: "invalid_union",
        path: ["authProvider"],
        message: "Invalid input",
      });
      expect((unknown.error.issues[0] as { note?: string }).note).toBe(
        "No matching discriminator",
      );
    }

    const missing = ssoProviderSchema.safeParse({
      domain: "acme.test",
      authConfig: oidc,
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(describeIssue(missing.error.issues[0])).toEqual({
        code: "invalid_union",
        path: ["authProvider"],
        message: "Invalid input",
      });
      expect((missing.error.issues[0] as { note?: string }).note).toBe(
        "No matching discriminator",
      );
    }
  });

  // D13
  it("D13 keeps gitlab.issuer, keycloak.name and custom.scope optional/nullable", () => {
    expect(
      gitlabSsoConfig.safeParse({
        domain: "acme.test",
        authProvider: "gitlab",
        authConfig: oidc,
      }).success,
    ).toBe(true);

    expect(
      keycloakSsoConfig.safeParse({
        domain: "acme.test",
        authProvider: "keycloak",
        authConfig: {
          ...oidc,
          issuer: "https://keycloak.example.com/realms/x",
        },
      }).success,
    ).toBe(true);

    const customNullScope = customSsoConfig.safeParse({
      domain: "acme.test",
      authProvider: "custom",
      authConfig: {
        ...oidc,
        name: "Custom",
        issuer: "https://idp.example.com",
        scope: null,
      },
    });
    expect(customNullScope.success).toBe(true);
    if (customNullScope.success) {
      expect(customNullScope.data.authConfig?.scope).toBeNull();
    }
  });

  // D14
  it("D14 requires clientId and clientSecret", () => {
    for (const missing of ["clientId", "clientSecret"] as const) {
      const authConfig: Record<string, unknown> = {
        ...oidc,
        issuer: "https://tenant.okta.com",
      };
      delete authConfig[missing];
      const result = ssoProviderSchema.safeParse({
        domain: "acme.test",
        authProvider: "okta",
        authConfig,
      });
      expect({ missingField: missing, success: result.success }).toEqual({
        missingField: missing,
        success: false,
      });
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes(missing))).toBe(
          true,
        );
      }
    }
  });

  // D1/D2 control for the per-provider schemas: the 13 exported schemas accept
  // only their own tag (the tag is frozen by the export name).
  it("exposes one single-provider schema per tag, each accepting only its own tag", () => {
    const schemas = [
      ["google", googleSsoConfig],
      ["github", githubSsoConfig],
      ["github-enterprise", githubEnterpriseSsoConfig],
      ["gitlab", gitlabSsoConfig],
      ["auth0", auth0SsoConfig],
      ["okta", oktaSsoConfig],
      ["authentik", authentikSsoConfig],
      ["onelogin", oneloginSsoConfig],
      ["azure-ad", azureAdSsoConfig],
      ["cognito", cognitoSsoConfig],
      ["keycloak", keycloakSsoConfig],
      ["jumpcloud", jumpcloudSsoConfig],
      ["custom", customSsoConfig],
    ] as const;

    for (const [tag, schema] of schemas) {
      const ownTag = schema.safeParse({
        domain: "acme.test",
        authProvider: tag,
        authConfig: minimalAuthConfigs[tag],
      });
      expect({ tag, success: ownTag.success }).toEqual({
        tag,
        success: true,
      });

      const otherTag = tag === "okta" ? "google" : "okta";
      const foreignTag = schema.safeParse({
        domain: "acme.test",
        authProvider: otherTag,
        authConfig: minimalAuthConfigs[otherTag],
      });
      expect({ tag, rejectedOther: !foreignTag.success }).toEqual({
        tag,
        rejectedOther: true,
      });
    }
  });
});
