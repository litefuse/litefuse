import { describe, expect, it } from "vitest";

import { UsageDetails } from "./types";

describe("UsageDetails", () => {
  it("preserves inclusive OpenAI prompt and completion totals with token details", () => {
    const result = UsageDetails.parse({
      prompt_tokens: 67,
      completion_tokens: 18,
      total_tokens: 85,
      prompt_tokens_details: {
        cached_tokens: 0,
        text_tokens: 67,
      },
      completion_tokens_details: {
        reasoning_tokens: 16,
        text_tokens: 18,
      },
    });

    expect(result).toEqual({
      input: 67,
      output: 18,
      total: 85,
      input_cached_tokens: 0,
      input_text_tokens: 67,
      output_reasoning_tokens: 16,
      output_text_tokens: 18,
    });
  });

  it("preserves inclusive OpenAI Response API totals with token details", () => {
    const result = UsageDetails.parse({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: {
        text_tokens: 80,
        image_tokens: 20,
      },
      output_tokens_details: {
        reasoning_tokens: 40,
        text_tokens: 50,
      },
    });

    expect(result).toEqual({
      input: 100,
      output: 50,
      total: 150,
      input_text_tokens: 80,
      input_image_tokens: 20,
      output_reasoning_tokens: 40,
      output_text_tokens: 50,
    });
  });
});
