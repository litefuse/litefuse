import { cn } from "@/src/utils/tailwind";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const statusCategories = {
  active: ["production", "live", "active", "public"],
  pending: ["pending", "waiting", "queued"],
  delayed: ["delayed"],
  inactive: ["disabled", "inactive"],
  paused: ["paused"],
  completed: ["completed", "done", "finished"],
  error: ["error", "failed"],
  partial: ["partial"],
};

export type Status =
  (typeof statusCategories)[keyof typeof statusCategories][number];

/**
 * The badge renders the raw status value, so the label has to be looked up
 * here. An unknown status falls back to the capitalised value, as before.
 */
const statusLabels: Record<string, string> = {
  production: i18nKey("Production"),
  live: i18nKey("Live"),
  active: i18nKey("Active"),
  public: i18nKey("Public"),
  pending: i18nKey("Pending"),
  waiting: i18nKey("Waiting"),
  queued: i18nKey("Queued"),
  delayed: i18nKey("Delayed"),
  disabled: i18nKey("Disabled"),
  inactive: i18nKey("Inactive"),
  paused: i18nKey("Paused"),
  completed: i18nKey("Completed"),
  done: i18nKey("Done"),
  finished: i18nKey("Finished"),
  error: i18nKey("Error"),
  failed: i18nKey("Failed"),
  partial: i18nKey("Partial"),
};

/**
 * The badge's label for a raw status value, as an i18n key. Sidebar filter
 * facets over the same column use this so their options read like the badges.
 */
export const statusLabelKey = (status: string): string => {
  const normalized = status?.toLowerCase() ?? "";
  return (
    statusLabels[normalized] ??
    (status ? status[0].toUpperCase() + status.slice(1) : status)
  );
};

export const StatusBadge = ({
  type,
  isLive = true,
  className,
  showText = true,
  children,
}: {
  type: Status | (string & {});
  isLive?: boolean;
  className?: string;
  showText?: boolean;
  children?: ReactNode;
}) => {
  const { t } = useTranslation();
  let badgeColor = "bg-muted-gray text-primary";
  let dotColor = "bg-muted-foreground";
  let dotPingColor = "bg-muted-foreground";
  let showDot = isLive;

  const normalizedType = type?.toLowerCase() ?? "";

  if (statusCategories.active.includes(normalizedType)) {
    badgeColor = "bg-light-green text-dark-green";
    dotColor = "animate-ping bg-dark-green";
    dotPingColor = "bg-dark-green";
  } else if (statusCategories.pending.includes(normalizedType)) {
    badgeColor = "bg-light-yellow text-dark-yellow";
    dotColor = "animate-ping bg-dark-yellow";
    dotPingColor = "bg-dark-yellow";
  } else if (statusCategories.delayed.includes(normalizedType)) {
    badgeColor = "bg-light-blue text-dark-blue";
    dotColor = "animate-ping bg-dark-blue";
    dotPingColor = "bg-dark-blue";
  } else if (statusCategories.paused.includes(normalizedType)) {
    badgeColor = "bg-light-yellow text-dark-yellow";
    dotPingColor = "bg-dark-yellow";
  } else if (statusCategories.error.includes(normalizedType)) {
    badgeColor = "bg-light-red text-dark-red";
    showDot = false;
  } else if (statusCategories.completed.includes(normalizedType)) {
    badgeColor = "bg-light-green text-dark-green";
    showDot = false;
  } else if (statusCategories.partial.includes(normalizedType)) {
    badgeColor = "bg-light-yellow text-dark-yellow";
    showDot = false;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs",
        badgeColor,
        className,
      )}
    >
      {showDot && (
        <span className="relative inline-flex h-2 w-2">
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75",
              dotColor,
            )}
          ></span>
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              dotPingColor,
            )}
          ></span>
        </span>
      )}
      {showText && type && <span>{t(statusLabelKey(type))}</span>}
      {children}
    </div>
  );
};
