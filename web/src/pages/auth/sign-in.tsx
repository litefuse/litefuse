import { type GetServerSideProps } from "next";
import { LangfuseIcon } from "@/src/components/LangfuseLogo";
import { Button } from "@/src/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/src/components/ui/form";
import { Input } from "@/src/components/ui/input";
import { env } from "@/src/env.mjs";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/src/features/i18n/LanguageSwitcher";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  SiOkta,
  SiAuthentik,
  SiAuth0,
  SiClickhouse,
  SiAmazoncognito,
  SiKeycloak,
  SiGoogle,
  SiGitlab,
  SiGithub,
  SiWordpress,
} from "react-icons/si";
import { TbBrandAzure, TbBrandOauth } from "react-icons/tb";
import { signIn } from "next-auth/react";
import Head from "next/head";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod/v4";
import { CloudPrivacyNotice } from "@/src/features/auth/components/AuthCloudPrivacyNotice";
import { PasswordInput } from "@/src/components/ui/password-input";
import { Code, Key } from "lucide-react";
import { useRouter } from "next/router";
import { captureException } from "@sentry/nextjs";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import useLocalStorage from "@/src/components/useLocalStorage";
import { AuthProviderButton } from "@/src/features/auth/components/AuthProviderButton";
import { cn } from "@/src/utils/tailwind";
import { useLangfuseCloudRegion } from "@/src/features/organizations/hooks";
import { getSafeRedirectPath } from "@/src/utils/redirect";
import { hasSsoConfig } from "@/src/features/enterprise/sso/ssoProviders";

import { i18nKey } from "@/src/features/i18n/i18nKey";

/** Example address shown in the field, identical in every language. */
const EXAMPLE_EMAIL = "jsdoe@example.com";
const credentialAuthForm = z.object({
  email: z.string().email(),
  password: z.string().min(8, {
    message: i18nKey("Password must be at least 8 characters long"),
  }),
});

const DEMO_CREDENTIALS = {
  email: "demo@litefuse.ai",
  password: "password",
};

// Also used in src/pages/auth/sign-up.tsx
export type PageProps = {
  authProviders: {
    credentials: boolean;
    google: boolean;
    github: boolean;
    githubEnterprise: boolean;
    gitlab: boolean;
    okta: boolean;
    authentik: boolean;
    onelogin: boolean;
    azureAd: boolean;
    auth0: boolean;
    dorisCloud: boolean;
    cognito: boolean;
    keycloak:
      | {
          name: string;
        }
      | boolean;
    workos:
      | {
          organizationId: string;
        }
      | {
          connectionId: string;
        }
      | boolean;
    wordpress: boolean;
    custom:
      | {
          name: string;
        }
      | false;
    sso: boolean;
  };
  runningOnHuggingFaceSpaces: boolean;
  signUpDisabled: boolean;
  showDemoSignIn: boolean;
};

type CredentialsSubmitAction = "standard" | "demo";

// Also used in src/pages/auth/sign-up.tsx

export const getServerSideProps: GetServerSideProps<PageProps> = async () => {
  // Dynamically detect whether multi-tenant SSO (Enterprise SSO) is configured
  const sso: boolean = await hasSsoConfig();
  return {
    props: {
      authProviders: {
        google:
          env.AUTH_GOOGLE_CLIENT_ID !== undefined &&
          env.AUTH_GOOGLE_CLIENT_SECRET !== undefined,
        github:
          env.AUTH_GITHUB_CLIENT_ID !== undefined &&
          env.AUTH_GITHUB_CLIENT_SECRET !== undefined,
        githubEnterprise:
          env.AUTH_GITHUB_ENTERPRISE_CLIENT_ID !== undefined &&
          env.AUTH_GITHUB_ENTERPRISE_CLIENT_SECRET !== undefined &&
          env.AUTH_GITHUB_ENTERPRISE_BASE_URL !== undefined,
        gitlab:
          env.AUTH_GITLAB_CLIENT_ID !== undefined &&
          env.AUTH_GITLAB_CLIENT_SECRET !== undefined,
        okta:
          env.AUTH_OKTA_CLIENT_ID !== undefined &&
          env.AUTH_OKTA_CLIENT_SECRET !== undefined &&
          env.AUTH_OKTA_ISSUER !== undefined,
        authentik:
          env.AUTH_AUTHENTIK_CLIENT_ID !== undefined &&
          env.AUTH_AUTHENTIK_CLIENT_SECRET !== undefined &&
          env.AUTH_AUTHENTIK_ISSUER !== undefined,
        onelogin:
          env.AUTH_ONELOGIN_CLIENT_ID !== undefined &&
          env.AUTH_ONELOGIN_CLIENT_SECRET !== undefined &&
          env.AUTH_ONELOGIN_ISSUER !== undefined,
        credentials: env.AUTH_DISABLE_USERNAME_PASSWORD !== "true",
        azureAd:
          env.AUTH_AZURE_AD_CLIENT_ID !== undefined &&
          env.AUTH_AZURE_AD_CLIENT_SECRET !== undefined &&
          env.AUTH_AZURE_AD_TENANT_ID !== undefined,
        auth0:
          env.AUTH_AUTH0_CLIENT_ID !== undefined &&
          env.AUTH_AUTH0_CLIENT_SECRET !== undefined &&
          env.AUTH_AUTH0_ISSUER !== undefined,
        // Langfuse Cloud only — NOT for self-hosted Langfuse
        dorisCloud:
          env.AUTH_DORIS_CLOUD_CLIENT_ID !== undefined &&
          env.AUTH_DORIS_CLOUD_CLIENT_SECRET !== undefined &&
          env.AUTH_DORIS_CLOUD_ISSUER !== undefined &&
          env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION !== undefined,
        cognito:
          env.AUTH_COGNITO_CLIENT_ID !== undefined &&
          env.AUTH_COGNITO_CLIENT_SECRET !== undefined &&
          env.AUTH_COGNITO_ISSUER !== undefined,
        keycloak:
          env.AUTH_KEYCLOAK_CLIENT_ID !== undefined &&
          env.AUTH_KEYCLOAK_CLIENT_SECRET !== undefined &&
          env.AUTH_KEYCLOAK_ISSUER !== undefined
            ? env.AUTH_KEYCLOAK_NAME !== undefined
              ? { name: env.AUTH_KEYCLOAK_NAME }
              : true
            : false,
        workos:
          env.AUTH_WORKOS_CLIENT_ID !== undefined &&
          env.AUTH_WORKOS_CLIENT_SECRET !== undefined
            ? env.AUTH_WORKOS_ORGANIZATION_ID !== undefined
              ? { organizationId: env.AUTH_WORKOS_ORGANIZATION_ID }
              : env.AUTH_WORKOS_CONNECTION_ID !== undefined
                ? { connectionId: env.AUTH_WORKOS_CONNECTION_ID }
                : true
            : false,
        wordpress:
          env.AUTH_WORDPRESS_CLIENT_ID !== undefined &&
          env.AUTH_WORDPRESS_CLIENT_SECRET !== undefined,
        custom:
          env.AUTH_CUSTOM_CLIENT_ID !== undefined &&
          env.AUTH_CUSTOM_CLIENT_SECRET !== undefined &&
          env.AUTH_CUSTOM_ISSUER !== undefined &&
          env.AUTH_CUSTOM_NAME !== undefined
            ? { name: env.AUTH_CUSTOM_NAME }
            : false,
        sso,
      },
      signUpDisabled: env.AUTH_DISABLE_SIGNUP === "true",
      showDemoSignIn: env.AUTH_DEMO_SIGN_IN_ENABLED === "true",
      runningOnHuggingFaceSpaces: env.NEXTAUTH_URL?.replace(
        "/api/auth",
        "",
      ).endsWith(".hf.space"),
    },
  };
};

type NextAuthProvider = NonNullable<Parameters<typeof signIn>[0]>;

// Also used in src/pages/auth/sign-up.tsx
export function SSOButtons({
  authProviders,
  action = "sign in",
  lastUsedMethod,
  onProviderSelect,
}: {
  authProviders: PageProps["authProviders"];
  action?: string;
  lastUsedMethod?: NextAuthProvider | null;
  onProviderSelect?: (provider: NextAuthProvider) => void;
}) {
  const { t } = useTranslation();
  const capture = usePostHogClientCapture();
  const [providerSigningIn, setProviderSigningIn] =
    useState<NextAuthProvider | null>(null);

  // Count available auth methods (including credentials if available)
  const availableProviders = Object.entries(authProviders).filter(
    ([name, enabled]) => enabled && name !== "sso", // sso is just a flag, not an actual provider
  );
  const hasMultipleAuthMethods = availableProviders.length > 1;

  const handleSignIn = (provider: NextAuthProvider) => {
    setProviderSigningIn(provider);
    capture("sign_in:button_click", { provider });

    // Notify parent component about provider selection
    onProviderSelect?.(provider);

    signIn(provider)
      .then(() => {
        // do not reset loadingProvider here, as the page will reload
      })
      .catch((error) => {
        console.error(error);
        setProviderSigningIn(null);
      });
  };

  // Only show separator if credentials are enabled (for sign-in) or if action is sign-up (which always has the form)
  const showSeparator = authProviders.credentials || action !== "sign in";

  return (
    // any authprovider from props is enabled
    Object.entries(authProviders).some(
      ([name, enabled]) => enabled && name !== "credentials",
    ) ? (
      <div>
        {showSeparator ? (
          action === "sign in" ? (
            <div className="border-border my-6 border-t"></div>
          ) : (
            <div className="text-muted-foreground my-6 text-center text-xs">
              {t("or {{action}} with", { action })}
            </div>
          )
        ) : null}
        <div className="flex flex-row flex-wrap items-center justify-center gap-2">
          {authProviders.sso && (
            <AuthProviderButton
              icon={<Key className="mr-3" size={18} />}
              label={t("Enterprise SSO")}
              onClick={() => {
                capture("sign_in:button_click", { provider: "sso" });
                window.location.href = `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/auth/enterprise-sso-required`;
              }}
            />
          )}
          {authProviders.google && (
            <AuthProviderButton
              icon={<SiGoogle className="mr-3" size={18} />}
              label={t("Google")}
              onClick={() => handleSignIn("google")}
              loading={providerSigningIn === "google"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "google"
              }
            />
          )}
          {authProviders.github && (
            <AuthProviderButton
              icon={<SiGithub className="mr-3" size={18} />}
              label={t("GitHub")}
              onClick={() => handleSignIn("github")}
              loading={providerSigningIn === "github"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "github"
              }
            />
          )}
          {authProviders.githubEnterprise && (
            <AuthProviderButton
              icon={<SiGithub className="mr-3" size={18} />}
              label={t("GitHub Enterprise")}
              onClick={() => handleSignIn("github-enterprise")}
              loading={providerSigningIn === "github-enterprise"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "github-enterprise"
              }
            />
          )}
          {authProviders.gitlab && (
            <AuthProviderButton
              icon={<SiGitlab className="mr-3" size={18} />}
              label={t("Gitlab")}
              onClick={() => handleSignIn("gitlab")}
              loading={providerSigningIn === "gitlab"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "gitlab"
              }
            />
          )}
          {authProviders.azureAd && (
            <AuthProviderButton
              icon={<TbBrandAzure className="mr-3" size={18} />}
              label={t("Azure AD")}
              onClick={() => handleSignIn("azure-ad")}
              loading={providerSigningIn === "azure-ad"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "azure-ad"
              }
            />
          )}
          {authProviders.okta && (
            <AuthProviderButton
              icon={<SiOkta className="mr-3" size={18} />}
              label={t("Okta")}
              onClick={() => handleSignIn("okta")}
              loading={providerSigningIn === "okta"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "okta"
              }
            />
          )}
          {authProviders.authentik && (
            <AuthProviderButton
              icon={<SiAuthentik className="mr-3" size={18} />}
              label={t("Authentik")}
              onClick={() => handleSignIn("authentik")}
              loading={providerSigningIn === "authentik"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "authentik"
              }
            />
          )}
          {authProviders.onelogin && (
            <AuthProviderButton
              icon={<Key className="mr-3" size={18} />}
              label={t("OneLogin")}
              onClick={() => handleSignIn("onelogin")}
              loading={providerSigningIn === "onelogin"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "onelogin"
              }
            />
          )}
          {authProviders.auth0 && (
            <AuthProviderButton
              icon={<SiAuth0 className="mr-3" size={18} />}
              label={t("Auth0")}
              onClick={() => handleSignIn("auth0")}
              loading={providerSigningIn === "auth0"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "auth0"
              }
            />
          )}
          {authProviders.dorisCloud && (
            <AuthProviderButton
              icon={<SiClickhouse className="mr-3" size={18} />}
              label={t("Doris Cloud")}
              onClick={() => handleSignIn("doris-cloud")}
              loading={providerSigningIn === "doris-cloud"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "doris-cloud"
              }
            />
          )}
          {authProviders.cognito && (
            <AuthProviderButton
              icon={<SiAmazoncognito className="mr-3" size={18} />}
              label={t("Cognito")}
              onClick={() => handleSignIn("cognito")}
              loading={providerSigningIn === "cognito"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "cognito"
              }
            />
          )}
          {authProviders.keycloak && (
            <AuthProviderButton
              icon={<SiKeycloak className="mr-3" size={18} />}
              label={
                typeof authProviders.keycloak === "object"
                  ? authProviders.keycloak.name
                  : t("Keycloak")
              }
              onClick={() => {
                capture("sign_in:button_click", { provider: "keycloak" });
                onProviderSelect?.("keycloak");
                void signIn("keycloak");
              }}
              loading={providerSigningIn === "keycloak"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "keycloak"
              }
            />
          )}
          {typeof authProviders.workos === "object" &&
            "connectionId" in authProviders.workos && (
              <AuthProviderButton
                icon={<Code className="mr-3" size={18} />}
                label={t("WorkOS")}
                onClick={() => {
                  capture("sign_in:button_click", { provider: "workos" });
                  onProviderSelect?.("workos");
                  void signIn("workos", undefined, {
                    connection: (
                      authProviders.workos as { connectionId: string }
                    ).connectionId,
                  });
                }}
                loading={providerSigningIn === "workos"}
                showLastUsedBadge={
                  hasMultipleAuthMethods && lastUsedMethod === "workos"
                }
              />
            )}
          {typeof authProviders.workos === "object" &&
            "organizationId" in authProviders.workos && (
              <AuthProviderButton
                icon={<Code className="mr-3" size={18} />}
                label={t("WorkOS")}
                onClick={() => {
                  capture("sign_in:button_click", { provider: "workos" });
                  onProviderSelect?.("workos");
                  void signIn("workos", undefined, {
                    organization: (
                      authProviders.workos as { organizationId: string }
                    ).organizationId,
                  });
                }}
                loading={providerSigningIn === "workos"}
                showLastUsedBadge={
                  hasMultipleAuthMethods && lastUsedMethod === "workos"
                }
              />
            )}
          {authProviders.workos === true && (
            <>
              <AuthProviderButton
                icon={<Code className="mr-3" size={18} />}
                label={t("WorkOS (organization)")}
                onClick={() => {
                  const organization = window.prompt(
                    "Please enter your organization ID",
                  );
                  if (organization) {
                    capture("sign_in:button_click", { provider: "workos" });
                    onProviderSelect?.("workos");
                    void signIn("workos", undefined, {
                      organization,
                    });
                  }
                }}
                loading={providerSigningIn === "workos"}
                showLastUsedBadge={
                  hasMultipleAuthMethods && lastUsedMethod === "workos"
                }
              />
              <AuthProviderButton
                icon={<Code className="mr-3" size={18} />}
                label={t("WorkOS (connection)")}
                onClick={() => {
                  const connection = window.prompt(
                    "Please enter your connection ID",
                  );
                  if (connection) {
                    capture("sign_in:button_click", { provider: "workos" });
                    onProviderSelect?.("workos");
                    void signIn("workos", undefined, {
                      connection,
                    });
                  }
                }}
                loading={providerSigningIn === "workos"}
                showLastUsedBadge={
                  hasMultipleAuthMethods && lastUsedMethod === "workos"
                }
              />
            </>
          )}
          {authProviders.wordpress && (
            <AuthProviderButton
              icon={<SiWordpress className="mr-3" size={18} />}
              label={t("WordPress")}
              onClick={() => handleSignIn("wordpress")}
              loading={providerSigningIn === "wordpress"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "wordpress"
              }
            />
          )}
          {authProviders.custom && (
            <AuthProviderButton
              icon={<TbBrandOauth className="mr-3" size={18} />}
              label={authProviders.custom.name}
              onClick={() => handleSignIn("custom")}
              loading={providerSigningIn === "custom"}
              showLastUsedBadge={
                hasMultipleAuthMethods && lastUsedMethod === "custom"
              }
            />
          )}
        </div>
      </div>
    ) : null
  );
}

/**
 * Redirect to HuggingFace Spaces auth page (/auth/hf-spaces) if running in an iframe on a HuggingFace host.
 * The iframe detection needs to happen client-side since window/document objects are not available during SSR.
 * @param runningOnHuggingFaceSpaces - whether the app is running on a HuggingFace spaces, needs to be checked server-side
 */
export function useHuggingFaceRedirect(runningOnHuggingFaceSpaces: boolean) {
  const router = useRouter();

  useEffect(() => {
    const isInIframe = () => {
      try {
        return window.self !== window.top;
      } catch {
        return true;
      }
    };

    if (
      runningOnHuggingFaceSpaces &&
      typeof window !== "undefined" &&
      isInIframe()
    ) {
      void router.push("/auth/hf-spaces");
    }
  }, [router, runningOnHuggingFaceSpaces]);
}

const signInErrors = [
  {
    code: "OAuthAccountNotLinked",
    description: i18nKey(
      "Please sign in with the same provider (e.g. Google, GitHub, Azure AD, etc.) that you used to create this account.",
    ),
  },
];

export default function SignIn({
  authProviders,
  signUpDisabled,
  showDemoSignIn,
  runningOnHuggingFaceSpaces,
}: PageProps) {
  const { t } = useTranslation();
  const router = useRouter();
  useHuggingFaceRedirect(runningOnHuggingFaceSpaces);

  // handle NextAuth error codes: https://next-auth.js.org/configuration/pages#sign-in-page
  const nextAuthError =
    typeof router.query.error === "string"
      ? decodeURIComponent(router.query.error)
      : null;
  const nextAuthErrorDescription =
    typeof router.query.error_description === "string"
      ? decodeURIComponent(router.query.error_description)
      : null;

  // Use error_description from IdP if available, otherwise use mapped error or error code
  const errorMessage = nextAuthErrorDescription
    ? nextAuthErrorDescription
    : (signInErrors.find((e) => e.code === nextAuthError)?.description ??
      nextAuthError);

  useEffect(() => {
    // log unexpected sign in errors to Sentry
    // An error is unexpected if it's not in our mapped errors and has no IdP error_description
    if (
      nextAuthError &&
      !nextAuthErrorDescription &&
      !signInErrors.find((e) => e.code === nextAuthError)
    ) {
      captureException(new Error(`Sign in error: ${nextAuthError}`));
    }
  }, [nextAuthError, nextAuthErrorDescription]);

  const [credentialsFormError, setCredentialsFormError] = useState<
    string | null
  >(errorMessage);
  const [activeCredentialsAction, setActiveCredentialsAction] =
    useState<CredentialsSubmitAction | null>(null);
  const [lastUsedAuthMethod, setLastUsedAuthMethod] =
    useLocalStorage<NextAuthProvider | null>(
      "langfuse_last_used_auth_method",
      null,
    );

  const capture = usePostHogClientCapture();
  const { isLangfuseCloud } = useLangfuseCloudRegion();

  // Count available auth methods to determine if we should show "Last used" badge
  const availableProviders = Object.entries(authProviders).filter(
    ([name, enabled]) => enabled && name !== "sso", // sso is just a flag, not an actual provider
  );
  const hasMultipleAuthMethods = availableProviders.length > 1;

  // Read query params for targetPath and email pre-population
  const queryTargetPath = router.query.targetPath as string | undefined;
  const emailParam = router.query.email as string | undefined;

  // Validate targetPath to prevent open redirect attacks
  const targetPath = queryTargetPath
    ? getSafeRedirectPath(queryTargetPath)
    : undefined;

  // Credentials
  const credentialsForm = useForm({
    resolver: zodResolver(credentialAuthForm),
    defaultValues: {
      email: emailParam ?? "",
      password: "",
    },
  });

  async function submitCredentials(action: CredentialsSubmitAction) {
    setActiveCredentialsAction(action);
    await credentialsForm.handleSubmit(onCredentialsSubmit, () => {
      setActiveCredentialsAction(null);
    })();
  }

  async function onCredentialsSubmit(
    values: z.infer<typeof credentialAuthForm>,
  ) {
    setCredentialsFormError(null);
    try {
      capture("sign_in:button_click", { provider: "email/password" });

      // Store credentials as the last used auth method before signing in
      setLastUsedAuthMethod("credentials");

      const result = await signIn("credentials", {
        email: values.email,
        password: values.password,
        callbackUrl: targetPath ?? "/",
        redirect: false,
      });
      if (result === undefined) {
        setCredentialsFormError("An unexpected error occurred.");
        captureException(new Error("Sign in result is undefined"));
      } else if (!result.ok) {
        if (!result.error) {
          captureException(
            new Error(
              `Sign in result error is falsy, result: ${JSON.stringify(result)}`,
            ),
          );
        }
        setCredentialsFormError(
          result?.error ?? "An unexpected error occurred.",
        );
      }
    } catch (error) {
      captureException(error);
      console.error(error);
      setCredentialsFormError("An unexpected error occurred.");
    } finally {
      setActiveCredentialsAction(null);
    }
  }

  async function handleDemoSignIn() {
    setCredentialsFormError(null);
    credentialsForm.clearErrors();
    credentialsForm.setValue("email", DEMO_CREDENTIALS.email, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    credentialsForm.setValue("password", DEMO_CREDENTIALS.password, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });

    await submitCredentials("demo");
  }

  return (
    <>
      <Head>
        <title>{t("Sign in | Litefuse")}</title>
      </Head>
      <div className="flex flex-1 flex-col py-6 sm:min-h-full sm:justify-center sm:px-6 sm:py-12 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <LangfuseIcon className="mx-auto" />
          <h2 className="text-primary mt-4 text-center text-2xl leading-9 font-bold tracking-tight">
            {t("Sign in to your account")}
          </h2>
        </div>

        {isLangfuseCloud && (
          <div className="bg-card mt-4 -mb-4 rounded-lg p-3 text-center text-sm sm:mx-auto sm:w-full sm:max-w-[480px] sm:rounded-lg sm:px-6">
            {t(
              "If you are experiencing issues signing in, please force refresh this page (CMD + SHIFT + R) or clear your browser cache.",
            )}{" "}
            <a
              href="mailto:support@litefuse.ai"
              className="text-primary-accent hover:text-hover-primary-accent cursor-pointer text-xs font-medium whitespace-nowrap"
            >
              {t("(contact us)")}
            </a>
          </div>
        )}

        <div className="bg-background mt-14 px-6 py-10 shadow-sm sm:mx-auto sm:w-full sm:max-w-[480px] sm:rounded-lg sm:px-10">
          <div className="space-y-6">
            {/* Email / (optional) password form – only when credentials auth is enabled */}
            {authProviders.credentials && (
              <div>
                <Form {...credentialsForm}>
                  <form
                    className="space-y-6"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitCredentials("standard");
                    }}
                  >
                    {/* Email input – always visible */}
                    <FormField
                      control={credentialsForm.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("Email")}</FormLabel>
                          <FormControl>
                            <Input
                              placeholder={EXAMPLE_EMAIL}
                              allowPasswordManager
                              autoComplete="email"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={credentialsForm.control}
                      name="password"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {t("Password")}{" "}
                            <Link
                              href="/auth/reset-password"
                              className="text-primary-accent hover:text-hover-primary-accent ml-1 text-xs"
                              tabIndex={-1}
                              title={t("What is this?")}
                            >
                              {t("(forgot password?)")}
                            </Link>
                          </FormLabel>
                          <FormControl>
                            <PasswordInput {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Primary action button */}
                    <Button
                      type="submit"
                      className="w-full"
                      loading={
                        credentialsForm.formState.isSubmitting &&
                        activeCredentialsAction === "standard"
                      }
                      disabled={
                        credentialsForm.watch("email") === "" ||
                        credentialsForm.watch("password") === ""
                      }
                      data-testid="submit-email-password-sign-in-form"
                    >
                      {t("Sign in")}
                    </Button>
                    {showDemoSignIn ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => void handleDemoSignIn()}
                        loading={
                          credentialsForm.formState.isSubmitting &&
                          activeCredentialsAction === "demo"
                        }
                      >
                        {t("Sign as Demo")}
                      </Button>
                    ) : null}
                  </form>
                </Form>
                <div
                  className={cn(
                    "text-muted-foreground mt-1 text-center text-xs",
                    hasMultipleAuthMethods &&
                      lastUsedAuthMethod === "credentials"
                      ? "block"
                      : "hidden",
                  )}
                >
                  {t("Last used")}
                </div>
              </div>
            )}
            {credentialsFormError ? (
              <div className="text-destructive text-center text-sm font-medium">
                {credentialsFormError}
                <br />
                {t("Contact support if this error is unexpected.")}{" "}
                {isLangfuseCloud &&
                  t("Make sure you are using the correct cloud data region.")}
              </div>
            ) : null}
            <SSOButtons
              authProviders={authProviders}
              lastUsedMethod={lastUsedAuthMethod}
              onProviderSelect={setLastUsedAuthMethod}
            />
          </div>

          {!signUpDisabled &&
          env.NEXT_PUBLIC_SIGN_UP_DISABLED !== "true" &&
          authProviders.credentials ? (
            <p className="text-muted-foreground mt-10 text-center text-sm">
              {t("No account yet?")}{" "}
              <Link
                href={`/auth/sign-up${router.asPath.includes("?") ? router.asPath.substring(router.asPath.indexOf("?")) : ""}`}
                className="text-primary-accent hover:text-hover-primary-accent leading-6 font-semibold"
              >
                {t("Sign up")}
              </Link>
            </p>
          ) : null}
        </div>
        <LanguageSwitcher className="mx-auto mt-8" />
        <CloudPrivacyNotice action={t("signing in")} />
      </div>
    </>
  );
}
