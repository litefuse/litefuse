// OSS replacement for the former `@/src/ee/features/ui-customization/useUiCustomization`
// hook. UI customization (custom logo, base URLs, support links, etc.) was an
// EE feature gated by the `self-host-ui-customization` entitlement, and is not
// available in the OSS build. The hook now always returns `null`, but we keep
// the typed shape so that callers can continue to use optional-chaining like
// `customization?.hostname` without TypeScript narrowing the value to `never`.

export type UiCustomization = {
  hostname?: string;
  documentationHref?: string;
  supportHref?: string;
  feedbackHref?: string;
  logoLightModeHref?: string;
  logoDarkModeHref?: string;
  defaultModelAdapter?: string;
  defaultBaseUrlOpenAI?: string;
  defaultBaseUrlAnthropic?: string;
  defaultBaseUrlAzure?: string;
  // Non-optional so callers can pass this object directly into navigation
  // filters; the OSS hook always returns `null`, so this is only relevant for
  // the type shape.
  visibleModules: string[];
};

export const useUiCustomization = (): UiCustomization | null => null;
