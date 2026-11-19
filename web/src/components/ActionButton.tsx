import React from "react";
import { Lock, AlertCircle, Sparkle } from "lucide-react";
import { Button, type ButtonProps } from "@/src/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/src/components/ui/hover-card";
import { HoverCardPortal } from "@radix-ui/react-hover-card";
import Link from "next/link";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";

import { i18nKey } from "@/src/features/i18n/i18nKey";
import { useTranslation } from "react-i18next";
const BUTTON_STATE_MESSAGES = {
  limitReached: i18nKey(
    "You have reached the limit ({{current}}/{{max}}) for this resource at your current plan. Upgrade your plan to increase the limit.",
  ),
  noAccess: i18nKey(
    "You do not have access to this resource, please ask your admin to grant you access.",
  ),
  entitlement: i18nKey("This feature is not available in your current plan."),
} as const;

interface ActionButtonProps extends ButtonProps {
  icon?: React.ReactNode;
  loading?: boolean;
  hasAccess?: boolean;
  hasEntitlement?: boolean;
  limitValue?: number;
  limit?: number | false;
  children: React.ReactNode;
  className?: string;
  href?: string;
  trackingEventName?: Parameters<ReturnType<typeof usePostHogClientCapture>>[0];
  trackingProps?: Record<string, unknown>;
}

export const ActionButton = React.forwardRef<
  HTMLButtonElement,
  ActionButtonProps
>(function ActionButton(
  {
    loading = false,
    hasAccess = true,
    hasEntitlement = true,
    limitValue,
    limit = false,
    disabled = false,
    children,
    icon,
    className,
    href,
    trackingEventName,
    trackingProps,
    ...buttonProps
  },
  ref,
) {
  const { t } = useTranslation();
  const capture = usePostHogClientCapture();
  const hasReachedLimit =
    typeof limit === "number" &&
    limitValue !== undefined &&
    limitValue >= limit;
  const isDisabled =
    disabled || !hasAccess || !hasEntitlement || hasReachedLimit;

  const getMessage = () => {
    if (!hasAccess) return t(BUTTON_STATE_MESSAGES.noAccess);
    if (!hasEntitlement) return t(BUTTON_STATE_MESSAGES.entitlement);
    if (
      hasReachedLimit &&
      typeof limit === "number" &&
      limitValue !== undefined
    ) {
      return t(BUTTON_STATE_MESSAGES.limitReached, {
        current: limitValue,
        max: limit,
      });
    }
    return null;
  };

  const message = getMessage();

  // Handle click tracking for external links
  const handleLinkClick = () => {
    if (trackingEventName && href && isExternalUrl(href)) {
      capture(trackingEventName, trackingProps ?? null);
    }
  };

  const btnContent = (
    <ButtonContent
      ref={ref}
      icon={icon}
      isDisabled={isDisabled}
      loading={loading}
      hasAccess={hasAccess}
      hasEntitlement={hasEntitlement}
      hasReachedLimit={hasReachedLimit}
      className={className}
      buttonProps={buttonProps}
      href={href}
      onLinkClick={handleLinkClick}
    >
      {children}
    </ButtonContent>
  );

  if (isDisabled && message) {
    return (
      <HoverCard openDelay={200}>
        <HoverCardTrigger asChild>
          <span>{btnContent}</span>
        </HoverCardTrigger>
        <HoverCardPortal>
          <HoverCardContent className="w-80 text-sm">
            {message}
          </HoverCardContent>
        </HoverCardPortal>
      </HoverCard>
    );
  }

  return btnContent;
});

const isExternalUrl = (url: string) => {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("//")
  );
};

const ButtonContent = React.forwardRef<
  HTMLButtonElement,
  {
    icon?: React.ReactNode;
    isDisabled: boolean;
    loading: boolean;
    hasAccess: boolean;
    hasEntitlement: boolean;
    hasReachedLimit: boolean;
    className?: string;
    buttonProps: Omit<ButtonProps, "disabled" | "loading" | "className">;
    children: React.ReactNode;
    href?: string;
    onLinkClick?: () => void;
  }
>(function ButtonContent(
  {
    icon,
    isDisabled,
    loading,
    hasAccess,
    hasEntitlement,
    hasReachedLimit,
    className,
    buttonProps,
    children,
    href,
    onLinkClick,
  },
  ref,
) {
  const content = (
    <>
      {!hasAccess ? (
        <Lock className="mr-1 h-4 w-4" />
      ) : !hasEntitlement ? (
        <AlertCircle className="mr-1 h-4 w-4" />
      ) : hasReachedLimit ? (
        <Sparkle className="mr-1 h-4 w-4" />
      ) : icon ? (
        <div className="mr-1">{icon}</div>
      ) : null}
      {children}
    </>
  );

  const renderLink = href && !isDisabled;
  const isExternal = href && isExternalUrl(href);

  return (
    <Button
      ref={ref}
      disabled={isDisabled}
      loading={loading}
      className={className}
      {...buttonProps}
      asChild={renderLink ? true : undefined}
    >
      {renderLink ? (
        <Link
          href={href}
          target={isExternal ? "_blank" : undefined}
          rel={isExternal ? "noopener noreferrer" : undefined}
          onClick={onLinkClick}
        >
          {content}
        </Link>
      ) : (
        content
      )}
    </Button>
  );
});
