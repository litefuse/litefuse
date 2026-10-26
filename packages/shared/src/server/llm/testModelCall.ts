import { z as zodV3 } from "zod/v3";
import {
  ChatMessageRole,
  ChatMessageType,
  LLMApiKeySchema,
  type ModelConfig,
} from "./types";
import { fetchLLMCompletion } from "./fetchLLMCompletion";
import z from "zod/v4";

export const testModelCall = async ({
  provider,
  model,
  apiKey,
  modelConfig,
  // LITEFUSE ADDITION. Same as the matching entry in the param type below.
  structuredOutputSchema,
}: {
  provider: string;
  model: string;
  apiKey: z.infer<typeof LLMApiKeySchema>;
  modelConfig?: ModelConfig | null;
  /**
   * Optional. Added for the evaluators v2 preflight, which validates that a model
   * can produce the evaluator's output schema. Callers that omit it keep the
   * plain-text behaviour unchanged.
   */
  structuredOutputSchema?: z.ZodType;
}) => {
  await fetchLLMCompletion({
    streaming: false,
    llmConnection: apiKey,
    messages: [
      {
        role: ChatMessageRole.User,
        content:
          'Extract a score (1-5) and reasoning from this text: "This is a test. It worked perfectly because it matched all passing criteria."',
        type: ChatMessageType.User,
      },
    ],
    modelParams: {
      provider: provider,
      model: model,
      adapter: apiKey.adapter,
      ...modelConfig,
    },
    // LITEFUSE NOTE: a caller-supplied schema wins; the hard-coded test schema
    // stays the default so existing model-connection tests keep their exact
    // previous behaviour. (Upstream still calls this file testModelCall here,
    // the evaluators v2 preflight is an additional, additive caller.)
    structuredOutputSchema:
      structuredOutputSchema ??
      zodV3.object({
        score: zodV3.union([zodV3.string(), zodV3.number()]),
        reasoning: zodV3.string(),
      }),
  });
};
