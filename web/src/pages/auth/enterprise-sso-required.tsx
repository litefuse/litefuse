import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod/v4";
import { useForm } from "react-hook-form";
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
import { captureException } from "@sentry/nextjs";

import { Trans, useTranslation } from "react-i18next";

/** Example address shown in the field, identical in every language. */
const EXAMPLE_EMAIL = "jsdoe@example.com";
/** Support inbox, never translated. */
const SUPPORT_EMAIL = "support@litefuse.ai";
const enterpriseSsoFormSchema = z.object({
  email: z.string().email(),
});

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  "github-enterprise": "GitHub Enterprise",
  gitlab: "GitLab",
  "azure-ad": "Azure AD",
  okta: "Okta",
  authentik: "Authentik",
  onelogin: "OneLogin",
  auth0: "Auth0",
  cognito: "Cognito",
  keycloak: "Keycloak",
  workos: "WorkOS",
  wordpress: "WordPress",
  custom: "Custom OAuth",
};

export default function EnterpriseSsoRequiredPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { status: sessionStatus } = useSession();

  const emailFromQuery =
    typeof router.query.email === "string" ? router.query.email : "";
  const attemptedProvider =
    typeof router.query.attemptedProvider === "string"
      ? router.query.attemptedProvider
      : undefined;
  // callbackUrl must be an internal path; fall back to "/" (app home) so sign-in
  // lands on the workspace instead of looping back to this page (NextAuth treats
  // an empty callbackUrl as "current page").
  const rawCallbackUrl =
    typeof router.query.callbackUrl === "string" ? router.query.callbackUrl : "";
  const callbackUrl =
    rawCallbackUrl.startsWith("/") && !rawCallbackUrl.startsWith("//")
      ? rawCallbackUrl
      : "/";

  const friendlyProviderName = useMemo(() => {
    if (!attemptedProvider) return undefined;
    return (
      PROVIDER_LABELS[attemptedProvider] ?? attemptedProvider.replace(/-/g, " ")
    );
  }, [attemptedProvider]);

  const form = useForm<z.infer<typeof enterpriseSsoFormSchema>>({
    resolver: zodResolver(enterpriseSsoFormSchema),
    defaultValues: {
      email: emailFromQuery,
    },
  });

  useEffect(() => {
    if (emailFromQuery) {
      form.setValue("email", emailFromQuery);
    }
  }, [emailFromQuery, form]);

  // If already signed in (e.g. arriving here after an OAuth round-trip or from a
  // stale bookmark), go to the destination instead of showing the form again.
  useEffect(() => {
    if (sessionStatus === "authenticated") {
      router.replace(callbackUrl);
    }
  }, [sessionStatus, callbackUrl, router]);

  async function onSubmit(values: z.infer<typeof enterpriseSsoFormSchema>) {
    setError(null);
    setLoading(true);

    const domain = values.email.split("@")[1]?.toLowerCase();
    if (!domain) {
      form.setError("email", { message: t("Invalid email address") });
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(
        `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth/check-sso`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain }),
        },
      );

      if (response.ok) {
        const { providerId } = (await response.json()) as {
          providerId: string;
        };
        await signIn(providerId, {
          callbackUrl,
        });
        return;
      }

      if (response.status === 404) {
        setError(
          "We couldn't find a custom Enterprise SSO configuration for this domain. Double-check your company email or contact your administrator.",
        );
        return;
      }

      const data = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      setError(
        data?.message ??
          "Unable to start the Enterprise SSO sign-in flow. Please try again.",
      );
    } catch (err) {
      captureException(err);
      setError(
        "Something went wrong while checking your Enterprise SSO configuration. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  // Avoid flashing the form while an already-authenticated session is being
  // redirected to its destination.
  if (sessionStatus === "authenticated") {
    return null;
  }

  const description = friendlyProviderName
    ? t(
        "You tried signing in with {{provider}}, but this domain requires your company's custom Enterprise SSO.",
        { provider: friendlyProviderName },
      )
    : t("This domain requires your company's custom Enterprise SSO.");

  return (
    <>
      <Head>
        <title>{t("Enterprise SSO Required | Litefuse")}</title>
      </Head>
      <div className="min-h-screen-with-banner bg-background flex flex-col justify-center px-6 py-12 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <LangfuseIcon className="mx-auto" />
          <h1 className="text-primary mt-6 text-center text-2xl font-bold">
            {t("Use your Enterprise SSO")}
          </h1>
          <p className="text-muted-foreground mt-2 text-center text-sm leading-6">
            {description}{" "}
            {t(
              "Enter your company email so we can send you to the correct identity provider.",
            )}
          </p>
        </div>

        <div className="border-border bg-card mt-10 rounded-lg border px-6 py-8 shadow-sm sm:mx-auto sm:w-full sm:max-w-md">
          <Form {...form}>
            <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
              <FormField
                control={form.control}
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

              <Button
                type="submit"
                className="w-full"
                loading={loading}
                disabled={loading}
              >
                {t("Continue with Enterprise SSO")}
              </Button>
            </form>
          </Form>
          {error ? (
            <div className="text-destructive mt-4 text-center text-sm font-medium">
              {error}
              <br />
              <Trans
                i18nKey="Contact <0>support@litefuse.ai</0> if this keeps happening."
                components={[
                  <a
                    key="0"
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="text-primary-accent hover:text-hover-primary-accent"
                  />,
                ]}
              />
            </div>
          ) : null}
          <div className="text-muted-foreground mt-6 text-center text-sm">
            <Link
              href="/auth/sign-in"
              className="text-primary-accent hover:text-hover-primary-accent"
            >
              {t("Back to other sign-in options")}
            </Link>
          </div>
        </div>

        <div className="text-muted-foreground mt-4 text-center text-xs">
          {t("Need help? Contact")}{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary-accent hover:text-hover-primary-accent"
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </div>
      </div>
    </>
  );
}
