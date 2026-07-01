import {
  type OpenAICompatibleProviderHandler,
  processOpenAICompatibleBaseURL,
} from "./shared";

export const defaultOpenAICompatibleProviderHandler: OpenAICompatibleProviderHandler =
  {
    id: "default-openai",
    matches: () => true,
    buildConfig: ({ baseURL, modelName, providerOptions }) => ({
      baseURL: processOpenAICompatibleBaseURL({
        url: baseURL,
        modelName,
      }),
      modelKwargs: providerOptions,
    }),
  };
