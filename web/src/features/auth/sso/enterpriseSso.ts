import { type Provider } from "next-auth/providers/index";
import { logger, traceException } from "@langfuse/shared/src/server";

import { isMultiTenantSsoAvailable } from "@/src/features/auth/sso/isMultiTenantSsoAvailable";

/**
 * Community-edition-facing gateway to the Enterprise (paid) multi-tenant SSO
 * implementation.
 *
 * LICENSE-EE scopes the enterprise license to the paths in ANNEX A. The NextAuth
 * configuration and the sign-in page are plain community code, so they must not
 * import anything from there at module scope — otherwise a free deployment loads
 * licensed code just to render a login form. Routing those call sites through
 * this gateway keeps the community bundle free of enterprise modules: the EE
 * module is pulled in with a *dynamic* import, and only when the instance
 * actually holds an Enterprise license.
 *
 * FAIL CLOSED. There are two very different reasons why the enterprise
 * implementation may not be there, and they must not be conflated:
 *
 *   * the instance is not licensed — multi-tenant SSO is genuinely switched off,
 *     so every function returns the same value its enterprise counterpart would
 *     return without a license ([] / false / null / not-a-provider);
 *   * the instance IS licensed but the module could not be loaded (a missing
 *     chunk after a deploy, a module-initialisation failure) — that is an
 *     operational failure, and reporting it as "no SSO configured" would silently
 *     remove the domain-enforced SSO requirement from the sign-in flow. Every
 *     function therefore throws `EnterpriseSsoUnavailableError` instead.
 *
 * The enforcement call sites in `@/src/server/auth.ts` (the credentials
 * `authorize` callback and the `signIn` callback) await
 * `resolveSsoProviderIdForDomain` / `resolveMultiTenantSsoConfig` and treat a
 * rejected call as a failed sign-in, so an SSO-enforced domain cannot fall back
 * to password sign-in while the implementation is unloadable. The failure is
 * never cached: a later request retries the import.
 */

type EnterpriseSsoModule =
  typeof import("@/src/features/enterprise/sso/ssoProviders");

/**
 * The instance is licensed for enterprise SSO, but its implementation could not
 * be loaded. Thrown instead of returning a "feature disabled" value.
 */
export class EnterpriseSsoUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "Enterprise SSO is enabled on this instance, but its implementation could not be loaded. " +
        "Refusing to continue, so that domains with mandatory SSO cannot fall back to other sign-in methods.",
      { cause },
    );
    this.name = "EnterpriseSsoUnavailableError";
  }
}

let modulePromise: Promise<EnterpriseSsoModule> | null = null;

/**
 * Load the enterprise SSO module, or null when the instance is not licensed.
 *
 * The successful promise is cached so the dynamic import happens at most once per
 * process. A failed import clears the cache and rethrows: caching it would turn a
 * transient load error into a permanent "this instance has no SSO" answer.
 */
function loadEnterpriseSso(): Promise<EnterpriseSsoModule | null> {
  if (!isMultiTenantSsoAvailable) return Promise.resolve(null);
  if (modulePromise) return modulePromise;

  const attempt = import("@/src/features/enterprise/sso/ssoProviders").catch(
    (error) => {
      modulePromise = null;
      logger.error("Failed to load the enterprise SSO implementation", error);
      traceException(error);
      throw new EnterpriseSsoUnavailableError(error);
    },
  );

  modulePromise = attempt;
  return attempt;
}

export async function buildSsoProviders(): Promise<Provider[]> {
  const enterpriseSso = await loadEnterpriseSso();
  return enterpriseSso ? enterpriseSso.buildSsoProviders() : [];
}

export async function hasSsoConfig(): Promise<boolean> {
  const enterpriseSso = await loadEnterpriseSso();
  return enterpriseSso ? enterpriseSso.hasSsoConfig() : false;
}

export async function resolveSsoProviderIdForDomain(
  domain: string,
): Promise<string | null> {
  const enterpriseSso = await loadEnterpriseSso();
  return enterpriseSso
    ? enterpriseSso.resolveSsoProviderIdForDomain(domain)
    : null;
}

export async function resolveMultiTenantSsoConfig({
  providerId,
}: {
  providerId: string;
}): Promise<
  | { isMultiTenantSsoProvider: true; domain: string }
  | { isMultiTenantSsoProvider: false; domain: null }
> {
  const enterpriseSso = await loadEnterpriseSso();
  return enterpriseSso
    ? enterpriseSso.resolveMultiTenantSsoConfig({ providerId })
    : { isMultiTenantSsoProvider: false, domain: null };
}
