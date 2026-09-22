import { type TFunction } from "i18next";
import { getRuntimeLocale } from "@/src/features/i18n/runtimeLocale";
export const utcDateOffsetByDays = (days: number) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
};

export const localtimeDateOffsetByDays = (days: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
};
export const utcDate = (localDateTime: Date) =>
  new Date(
    Date.UTC(
      localDateTime.getFullYear(),
      localDateTime.getMonth(),
      localDateTime.getDate(),
    ),
  );

export const setBeginningOfDay = (date: Date) => {
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
};

export const setEndOfDay = (date: Date) => {
  const newDate = new Date(date);
  newDate.setHours(23, 59, 59, 999);
  return newDate;
};

export const intervalInSeconds = (start: Date, end: Date | null) =>
  end ? (end.getTime() - start.getTime()) / 1000 : 0;

export const formatIntervalSeconds = (seconds: number, scale: number = 2) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (num: number) => `00${num}`.slice(2);

  if (hrs > 0) return `${hrs}h ${pad(mins)}m ${pad(secs)}s`;
  if (mins > 0) return `${mins}m ${pad(secs)}s`;
  return `${seconds.toFixed(scale)}s`;
};

export const getShortLocalTimezone = () => {
  return new Date()
    .toLocaleTimeString("en-us", { timeZoneName: "short" })
    .split(" ")[2];
};

export const getTimezoneDetails = () => {
  const longLocalTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const location = longLocalTz.replace(/_/g, " ");
  const utcDifference = -(new Date().getTimezoneOffset() / 60); // negative because TZ info is the opposite of UTC offset
  return `${location} (UTC${utcDifference >= 0 ? "+" : ""}${utcDifference})`;
};

export const getRelativeTimestampFromNow = (
  timestamp: Date,
  t: TFunction,
): string => {
  const diffInMs = new Date().getTime() - timestamp.getTime();
  const diffInMinutes = diffInMs / (1000 * 60);
  const diffInHours = diffInMinutes / 60;
  const diffInDays = diffInHours / 24;

  if (diffInHours < 1) {
    return t("{{n}} minutes ago", { n: Math.floor(diffInMinutes) });
  } else if (diffInHours < 24) {
    return t("{{n}} hours ago", { n: Math.floor(diffInHours) });
  } else if (diffInDays < 7) {
    return t("{{n}} days ago", { n: Math.floor(diffInDays) });
  } else {
    return timestamp.toLocaleDateString(getRuntimeLocale(), {
      year: "2-digit",
      month: "numeric",
      day: "numeric",
    });
  }
};
