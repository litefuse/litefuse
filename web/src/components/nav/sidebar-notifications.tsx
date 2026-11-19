import { Button } from "@/src/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { X } from "lucide-react";
import useLocalStorage from "../useLocalStorage";
import Link from "next/link";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

type SidebarNotification = {
  id: string; // Add unique ID for each notification
  title: string; // i18nKey, rendered with t()
  description: string; // i18nKey, rendered with t()
  createdAt?: string; // optional, used to expire the notification
  link?: string;
  // defaults to "Learn more" if no linkContent and no linkTitle
  linkTitle?: string; // i18nKey, rendered with t()
  linkContent?: (t: TFunction) => React.ReactNode;
  // Time-to-live in milliseconds from createdAt. Defaults to TWO_WEEKS_MS.
  ttlMs?: number;
};

const notifications: SidebarNotification[] = [
  {
    id: "github-star",
    title: i18nKey("Star Litefuse"),
    description: i18nKey(
      "See the latest releases and help grow the community on GitHub",
    ),
    link: "https://github.com/selectdb/langfuse-doris",
    linkContent: (t) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={t("Litefuse GitHub stars")}
        src="https://img.shields.io/github/stars/selectdb/langfuse-doris?label=litefuse&style=social"
      />
    ),
  },
];

const STORAGE_KEY = "dismissed-sidebar-notifications";

export function SidebarNotifications() {
  const { t } = useTranslation();
  const capture = usePostHogClientCapture();

  const [dismissedNotifications, setDismissedNotifications] = useLocalStorage<
    string[]
  >(STORAGE_KEY, []);

  const isExpired = (notif: SidebarNotification) => {
    if (!notif.createdAt) return false;
    const created = new Date(notif.createdAt).getTime();
    const ttl = notif.ttlMs ?? TWO_WEEKS_MS;
    return Date.now() > created + ttl;
  };

  const dismissNotification = (id: string) => {
    setDismissedNotifications([...dismissedNotifications, id]);
  };

  // const activeNotifications = notifications.filter(
  //   (notif) => !dismissedNotifications.includes(notif.id) && !isExpired(notif),
  // );

  const activeNotifications = notifications.filter(() => false);

  if (activeNotifications.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 group-data-[collapsible=icon]:hidden">
      {activeNotifications.map((notification) => (
        <Card
          key={notification.id}
          className="bg-opacity-50 relative max-h-60 overflow-hidden rounded-md shadow-none"
        >
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-2.5 right-1.5 h-5 w-5 p-0"
            onClick={() => {
              capture("notification:dismiss_notification", {
                notification_id: notification.id,
              });
              dismissNotification(notification.id);
            }}
            title={t("Dismiss")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <CardHeader className="px-3 pt-2.5 pr-6 pb-0">
            <CardTitle className="text-sm">{t(notification.title)}</CardTitle>
            <CardDescription className="mt-1">
              {t(notification.description)}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-3 pt-1.5 pb-2.5">
            {notification.link &&
              (notification.linkContent ? (
                <Link
                  href={notification.link}
                  target="_blank"
                  onClick={() => {
                    capture("notification:click_link", {
                      notification_id: notification.id,
                    });
                  }}
                >
                  {notification.linkContent(t)}
                </Link>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  asChild
                >
                  <Link
                    href={notification.link}
                    target="_blank"
                    onClick={() => {
                      capture("notification:click_link", {
                        notification_id: notification.id,
                      });
                    }}
                  >
                    {notification.linkTitle
                      ? t(notification.linkTitle)
                      : t("Learn more")}{" "}
                    &rarr;
                  </Link>
                </Button>
              ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
