/**
 * OSS replacement for the EE useUiCustomization hook.
 *
 * The Enterprise Edition exposes a tRPC-backed customization payload (logos,
 * default base URLs, visible product modules, etc.). The OSS distribution has
 * no such feature, so this hook always returns `null` to keep the call-site
 * shapes stable.
 */

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
  visibleModules: string[];
};

export type UiCustomizationOption = keyof UiCustomization;

export const useUiCustomization = (): UiCustomization | null => null;
