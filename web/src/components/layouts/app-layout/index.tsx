/**
 * App Layout
 *
 * Improved maintainability through:
 * - Separation of concerns via custom hooks
 * - Composable navigation filters
 * - Layout variant components
 * - Memoization for performance
 *
 */

import { type PropsWithChildren, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { signOutWithSso } from "@/src/features/auth/lib/signOutWithSso";
import posthog from "posthog-js";
import { env } from "@/src/env.mjs";
import { forceSignOut } from "@/src/features/auth/lib/forceSignOut";
import { useQueryProjectOrOrganization } from "@/src/features/projects/hooks";
import { ErrorPageWithSentry } from "@/src/components/error-page";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

// Layout variants
import { LoadingLayout } from "./variants/LoadingLayout";
import { UnauthenticatedLayout } from "./variants/UnauthenticatedLayout";
import { MinimalLayout } from "./variants/MinimalLayout";
import { AuthenticatedLayout } from "./variants/AuthenticatedLayout";

// Custom hooks
import { useAuthSession } from "./hooks/useAuthSession";
import { useLayoutConfiguration } from "./hooks/useLayoutConfiguration";
import { markRootAutoEnterCompleted, useAuthGuard } from "./hooks/useAuthGuard";
import { useProjectAccess } from "./hooks/useProjectAccess";
import { useFilteredNavigation } from "./hooks/useFilteredNavigation";
import { useLayoutMetadata } from "./hooks/useLayoutMetadata";

function defaultPostSignOutPath(): string {
  const basePath = env.NEXT_PUBLIC_BASE_PATH ?? "";
  return `${basePath}/auth/sign-in`;
}

/**
 * Main layout component
 * Determines which layout variant to render based on:
 * - Authentication state
 * - Current route
 * - Project access
 * - User permissions
 */
export function AppLayout(props: PropsWithChildren) {
  const { t } = useTranslation();
  const router = useRouter();
  const signOutInProgress = useRef(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const session = useAuthSession({ isSigningOut });
  const { organization } = useQueryProjectOrOrganization();

  // Determine layout configuration
  const { variant, hideNavigation, isPublishable } = useLayoutConfiguration(
    session.data ?? null,
  );

  // Check authentication and redirects
  const authGuard = useAuthGuard(session, hideNavigation);

  // Check project access
  const projectAccess = useProjectAccess(session.data ?? null);

  // IMPORTANT: Call all hooks before any conditional returns
  // Load navigation and metadata (even if not used in all render paths)
  const navigation = useFilteredNavigation(session.data ?? null, organization);
  const activePathName = navigation.navigation.find(
    (item) => item.isActive,
  )?.title;
  const metadata = useLayoutMetadata(activePathName, navigation.navigation);

  // Handle auth guard actions (redirect or sign-out)
  useEffect(() => {
    // NextAuth publishes the unauthenticated session before signOut() resolves.
    // Keep this page's guard from replacing the pending IdP/error navigation.
    if (signOutInProgress.current) return;
    if (authGuard.action === "sign-out") {
      signOutInProgress.current = true;
      setIsSigningOut(true);
      // Invalid JWT (e.g. user deleted) — fully clear cookies so SSO is required
      void forceSignOut({ redirectTo: defaultPostSignOutPath() });
    } else if (authGuard.action === "redirect") {
      if (authGuard.url !== "/" && router.pathname === "/") {
        markRootAutoEnterCompleted();
      }
      void router.replace(authGuard.url);
    }
  }, [authGuard, router, isSigningOut]);

  useEffect(() => {
    const restoreFromHistory = (event: PageTransitionEvent) => {
      if (event.persisted) {
        signOutInProgress.current = false;
        setIsSigningOut(false);
      }
    };
    window.addEventListener("pageshow", restoreFromHistory);
    return () => window.removeEventListener("pageshow", restoreFromHistory);
  }, []);

  if (isSigningOut) return <LoadingLayout message={t("Signing out...")} />;

  // Loading or redirecting state
  if (
    authGuard.action === "loading" ||
    authGuard.action === "redirect" ||
    authGuard.action === "sign-out"
  ) {
    return <LoadingLayout message={authGuard.message} />;
  }

  // Project access denied - handle based on path type
  if (session.status === "authenticated" && !projectAccess.hasAccess) {
    // For publishable paths (shared traces/sessions), render minimal layout without sidebar
    // This allows authenticated users to view shared content without seeing project navigation
    if (isPublishable) {
      return <MinimalLayout>{props.children}</MinimalLayout>;
    }

    // For non-publishable paths, show error page
    return (
      <ErrorPageWithSentry
        title={t("Project Not Found")}
        message={t(
          "The project you are trying to access does not exist or you do not have access to it.",
        )}
        additionalButton={{
          label: t("Go to Home"),
          href: "/",
        }}
      />
    );
  }

  // Unauthenticated layout (sign-in, sign-up)
  // Must check variant BEFORE hideNavigation since auth pages set hideNavigation=true
  if (variant === "unauthenticated") {
    return <UnauthenticatedLayout>{props.children}</UnauthenticatedLayout>;
  }

  // Publishable paths (traces, sessions) when unauthenticated
  // Render minimal layout without navigation/sidebar
  if (isPublishable && session.status === "unauthenticated") {
    return <MinimalLayout>{props.children}</MinimalLayout>;
  }

  // Render minimal layout (onboarding, public routes)
  if (hideNavigation) {
    return <MinimalLayout>{props.children}</MinimalLayout>;
  }

  // Authenticated layout
  // At this point, all auth guards have passed and session.data is guaranteed to exist
  // The authGuard hook ensures we don't reach here without a valid session
  if (!session.data) {
    // This should never happen due to guards above, but TypeScript needs this
    return <LoadingLayout message={t("Loading")} />;
  }

  const handleSignOut = async () => {
    if (signOutInProgress.current) return;
    signOutInProgress.current = true;
    setIsSigningOut(true);
    try {
      if (env.NEXT_PUBLIC_POSTHOG_KEY && env.NEXT_PUBLIC_POSTHOG_HOST) {
        posthog.reset();
      }
      // signOutWithSso completes the NextAuth sign-out and returns the IdP
      // logout URL; forceSignOut then expires leftover session cookies on
      // every path before navigating there.
      await forceSignOut({
        redirectTo: await signOutWithSso(),
        nextAuthSignedOut: true,
      });
    } catch {
      signOutInProgress.current = false;
      setIsSigningOut(false);
      toast.error(t("Sign-out could not be completed. Please try again."));
    }
  };

  return (
    <AuthenticatedLayout
      session={session.data}
      navigation={navigation}
      metadata={metadata}
      onSignOut={handleSignOut}
    >
      {props.children}
    </AuthenticatedLayout>
  );
}
