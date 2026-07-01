import {
  type AnthropicCompatibleProviderHandler,
  processAnthropicCompatibleBaseURL,
} from "./shared";

export const defaultAnthropicCompatibleProviderHandler: AnthropicCompatibleProviderHandler =
  {
    id: "default-anthropic",
    matches: () => true,
    buildConfig: ({ baseURL, providerOptions }) => ({
      baseURL: processAnthropicCompatibleBaseURL(baseURL),
      invocationKwargs: providerOptions,
    }),
  };
