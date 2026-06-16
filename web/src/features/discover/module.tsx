// @ts-nocheck
/**
 * module.tsx — formerly the Grafana App Plugin entry point.
 *
 * This file is kept as a thin module re-export so existing internal
 * imports continue to resolve. The actual Next.js route entry points are:
 *   - src/pages/project/[projectId]/logging/index.tsx  → /project/[projectId]/logging
 *   - src/pages/project/[projectId]/logging/traces.tsx  → /project/[projectId]/logging/traces
 */
import dayjs from "dayjs";
import localeData from "dayjs/plugin/localeData";
import weekday from "dayjs/plugin/weekday";
import utc from "dayjs/plugin/utc";

dayjs.extend(weekday);
dayjs.extend(localeData);
dayjs.extend(utc);

const browserLang =
  typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
const supportedLocales = ["en", "zh-cn", "fr"];
const locale = supportedLocales.includes(browserLang) ? browserLang : "en";
dayjs.locale(locale);

export { default as PageDiscover } from "./views/PageDiscover";
export { default as PageTrace } from "./views/PageTrace";
