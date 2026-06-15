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
import { signupSchema } from "@/src/features/auth/lib/signupSchema";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import Head from "next/head";
import Link from "next/link";
import { useForm } from "react-hook-form";
import type * as z from "zod/v4";
import { env } from "@/src/env.mjs";
import { useState } from "react";
import { LangfuseIcon } from "@/src/components/LangfuseLogo";
import { CloudPrivacyNotice } from "@/src/features/auth/components/AuthCloudPrivacyNotice";
import { CloudRegionSwitch } from "@/src/features/auth/components/AuthCloudRegionSwitch";
import {
  SSOButtons,
  useHuggingFaceRedirect,
  type PageProps,
} from "@/src/pages/auth/sign-in";
import { PasswordInput } from "@/src/components/ui/password-input";
import { useLangfuseCloudRegion } from "@/src/features/organizations/hooks";
import { useRouter } from "next/router";
import { getSafeRedirectPath } from "@/src/utils/redirect";
import useLocalStorage from "@/src/components/useLocalStorage";

// Use the same getServerSideProps function as src/pages/auth/sign-in.tsx
export { getServerSideProps } from "@/src/pages/auth/sign-in";

type NextAuthProvider = NonNullable<Parameters<typeof signIn>[0]>;

export default function SignIn({
  authProviders,
  runningOnHuggingFaceSpaces,
}: PageProps) {
  useHuggingFaceRedirect(runningOnHuggingFaceSpaces);
  const { isLangfuseCloud, region } = useLangfuseCloudRegion();
  const router = useRouter();

  // Read query params for targetPath and email pre-population
  const queryTargetPath = router.query.targetPath as string | undefined;
  const emailParam = router.query.email as string | undefined;

  // Validate targetPath to prevent open redirect attacks
  const targetPath = queryTargetPath
    ? getSafeRedirectPath(queryTargetPath)
    : undefined;

  const [formError, setFormError] = useState<string | null>(null);

  const [lastUsedAuthMethod, setLastUsedAuthMethod] =
    useLocalStorage<NextAuthProvider | null>(
      "langfuse_last_used_auth_method",
      null,
    );

  const form = useForm({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      name: "",
      email: emailParam ?? "",
      password: "",
    },
  });

  async function onSubmit(values: z.infer<typeof signupSchema>) {
    try {
      setFormError(null);
      const res = await fetch(
        `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth/signup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );

      if (!res.ok) {
        const payload = (await res.json()) as { message: string };
        setFormError(payload.message);
        return;
      }

      await signIn<"credentials">("credentials", {
        email: values.email,
        password: values.password,
        callbackUrl:
          targetPath ??
          (isLangfuseCloud && region !== "DEV"
            ? `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/onboarding`
            : `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/`),
      });
    } catch {
      setFormError("An error occurred. Please try again.");
    }
  }

  return (
    <>
      <Head>
        <title>Sign up | Litefuse</title>
        <meta
          name="description"
          content="Create an account, no credit card required."
          key="desc"
        />
      </Head>
      <div className="flex flex-1 flex-col py-6 sm:min-h-full sm:justify-center sm:px-6 sm:py-12 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <LangfuseIcon className="mx-auto" />
          <h2 className="text-primary mt-4 text-center text-2xl leading-9 font-bold tracking-tight">
            Create new account
          </h2>
        </div>
        {isLangfuseCloud ? (
          <div className="text-center sm:mx-auto sm:w-full sm:max-w-[480px]">
            No credit card required.
          </div>
        ) : null}

        <CloudRegionSwitch isSignUpPage />

        <div className="bg-background mt-14 px-6 py-10 shadow-sm sm:mx-auto sm:w-full sm:max-w-[480px] sm:rounded-lg sm:px-10">
          <Form {...form}>
            <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Jane Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="jsdoe@example.com"
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
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <PasswordInput {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full"
                loading={form.formState.isSubmitting}
                data-testid="submit-email-password-sign-up-form"
              >
                Sign up
              </Button>
              {formError ? (
                <div className="text-destructive text-center text-sm font-medium">
                  {formError}
                </div>
              ) : null}
            </form>
          </Form>
          <SSOButtons
            authProviders={authProviders}
            action="sign up"
            lastUsedMethod={lastUsedAuthMethod}
            onProviderSelect={setLastUsedAuthMethod}
          />
          <p className="text-muted-foreground mt-10 text-center text-sm">
            Already have an account?{" "}
            <Link
              href={`/auth/sign-in${router.asPath.includes("?") ? router.asPath.substring(router.asPath.indexOf("?")) : ""}`}
              className="text-primary-accent hover:text-hover-primary-accent leading-6 font-semibold"
            >
              Sign in
            </Link>
          </p>
        </div>
        <CloudPrivacyNotice action="creating an account" />
      </div>
    </>
  );
}
