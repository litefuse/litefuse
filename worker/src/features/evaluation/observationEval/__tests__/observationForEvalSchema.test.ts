import { describe, it, expect } from "vitest";
import {
  observationForEvalSchema,
  type ObservationForEval,
  observationEvalFilterColumns,
  observationEvalVariableColumns,
  eventsEvalFilterColumns,
  mapEventEvalFilterColumnIdToField,
} from "@langfuse/shared";

describe("observationForEvalSchema", () => {
  describe("schema field validation", () => {
    it("should parse valid span_id field", () => {
      const evalId = observationForEvalSchema.shape.span_id;
      expect(evalId.parse("test-id")).toBe("test-id");
    });

    it("should parse valid type field", () => {
      const evalType = observationForEvalSchema.shape.type;
      expect(evalType.parse("GENERATION")).toBe("GENERATION");
    });

    it("should have environment field with default value", () => {
      // Environment has a default of "default" in the base schema
      const result = observationForEvalSchema.parse({
        span_id: "test",
        trace_id: "trace",
        project_id: "project",
        parent_span_id: null,
        type: "GENERATION",
        name: "test",
        level: "DEFAULT",
        status_message: null,
        version: null,
        trace_name: null,
        user_id: null,
        session_id: null,
        tags: [],
        release: null,
        provided_model_name: null,
        model_parameters: null,
        prompt_id: null,
        prompt_name: null,
        prompt_version: null,
        tool_definitions: {},
        tool_calls: [],
        tool_call_names: [],
        usage_details: {},
        cost_details: {},
        provided_usage_details: {},
        provided_cost_details: {},
        experiment_id: null,
        experiment_name: null,
        experiment_description: null,
        experiment_dataset_id: null,
        experiment_item_id: null,
        experiment_item_expected_output: null,
        input: null,
        output: null,
        metadata: {},
      });

      expect(result.environment).toBe("default");
    });
  });

  describe("schema validation", () => {
    const validObservation: ObservationForEval = {
      span_id: "obs-123",
      trace_id: "trace-456",
      project_id: "project-789",
      parent_span_id: null,
      type: "GENERATION",
      name: "test-observation",
      environment: "production",
      level: "DEFAULT",
      status_message: null,
      version: "v1.0",
      trace_name: "my-trace",
      user_id: "user-123",
      session_id: "session-456",
      is_root: false,
      tags: ["tag1", "tag2"],
      release: "v2.0.0",
      provided_model_name: "gpt-4",
      model_parameters: '{"temperature": 0.7}',
      prompt_id: null,
      prompt_name: "my-prompt",
      prompt_version: null,
      tool_definitions: { search: '{"description": "Search"}' },
      tool_calls: ['{"name": "search"}'],
      tool_call_names: ["search"],
      // Derived tool-call count (upstream's numeric `toolCalls` filter); the
      // projection that builds this record derives it from `tool_call_names`.
      tool_call_count: 1,
      usage_details: { input: 100, output: 50 },
      cost_details: { total: 0.01 },
      provided_usage_details: {},
      provided_cost_details: {},
      experiment_id: "exp-123",
      experiment_name: "test-experiment",
      experiment_description: "A test",
      experiment_dataset_id: "dataset-123",
      experiment_item_id: "item-123",
      experiment_item_expected_output: "expected output",
      input: '{"prompt": "Hello"}',
      output: '{"response": "World"}',
      metadata: { key: "value" },
    };

    it("should parse a valid observation", () => {
      const result = observationForEvalSchema.parse(validObservation);
      expect(result).toEqual(validObservation);
    });

    it("should accept null for nullable fields", () => {
      const observationWithNulls: ObservationForEval = {
        ...validObservation,
        parent_span_id: null,
        status_message: null,
        version: null,
        trace_name: null,
        user_id: null,
        session_id: null,
        release: null,
        provided_model_name: null,
        model_parameters: null,
        prompt_id: null,
        prompt_name: null,
        prompt_version: null,
        experiment_id: null,
        experiment_name: null,
        experiment_description: null,
        experiment_dataset_id: null,
        experiment_item_id: null,
        experiment_item_expected_output: null,
        input: null,
        output: null,
      };

      const result = observationForEvalSchema.parse(observationWithNulls);
      expect(result.user_id).toBeNull();
      expect(result.provided_model_name).toBeNull();
      expect(result.input).toBeNull();
    });

    it("should accept empty arrays for array fields", () => {
      const observationWithEmptyArrays = {
        ...validObservation,
        tags: [],
        tool_calls: [],
        tool_call_names: [],
      };

      const result = observationForEvalSchema.parse(observationWithEmptyArrays);
      expect(result.tags).toEqual([]);
      expect(result.tool_calls).toEqual([]);
      expect(result.tool_call_names).toEqual([]);
    });

    it("should accept empty objects for record fields", () => {
      const observationWithEmptyObjects = {
        ...validObservation,
        tool_definitions: {},
        usage_details: {},
        cost_details: {},
        metadata: {},
      };

      const result = observationForEvalSchema.parse(
        observationWithEmptyObjects,
      );
      expect(result.tool_definitions).toEqual({});
      expect(result.metadata).toEqual({});
    });

    it("should fail for missing required fields", () => {
      const invalidObservation = {
        span_id: "obs-123",
        // Missing other required fields
      };

      expect(() =>
        observationForEvalSchema.parse(invalidObservation),
      ).toThrow();
    });

    it("should accept the numeric spans.is_root encoding for is_root", () => {
      expect(
        observationForEvalSchema.parse({ ...validObservation, is_root: 1 })
          .is_root,
      ).toBe(true);
      expect(
        observationForEvalSchema.parse({ ...validObservation, is_root: 0 })
          .is_root,
      ).toBe(false);
    });

    it("should default is_root to false when the payload predates the field", () => {
      const withoutRootFlag: Record<string, unknown> = { ...validObservation };
      delete withoutRootFlag.is_root;

      expect(observationForEvalSchema.parse(withoutRootFlag).is_root).toBe(
        false,
      );
    });

    it("should expose is_root to the isRootObservation filter", () => {
      // The filter layer reads `observation[column.internal]`, so the column
      // must resolve to the boolean the in-memory comparison uses.
      const root = observationForEvalSchema.parse({
        ...validObservation,
        is_root: 1,
      });
      const child = observationForEvalSchema.parse({
        ...validObservation,
        is_root: 0,
      });

      expect(mapEventEvalFilterColumnIdToField(root, "isRootObservation")).toBe(
        true,
      );
      expect(
        mapEventEvalFilterColumnIdToField(child, "isRootObservation"),
      ).toBe(false);
    });
  });

  describe("filter columns alignment", () => {
    it("should have all filter column internal mappings present in schema", () => {
      const schemaKeys = Object.keys(observationForEvalSchema.shape);

      for (const column of observationEvalFilterColumns) {
        expect(schemaKeys).toContain(column.internal);
      }
    });

    it("should include expected filter columns", () => {
      const columnIds = eventsEvalFilterColumns.map((c) => c.id);

      // Observation properties
      expect(columnIds).toContain("type");
      expect(columnIds).toContain("name");
      expect(columnIds).toContain("environment");
      expect(columnIds).toContain("level");
      expect(columnIds).toContain("version");
      expect(columnIds).toContain("parentObservationId");
      // Upstream's root-span filter, backed by our precomputed `is_root` column.
      // Asserted explicitly because the list above is what the copied
      // evaluators-v2 rule UI and the RuleSetup default filter are checked
      // against.
      expect(columnIds).toContain("isRootObservation");

      // Trace-level properties
      expect(columnIds).toContain("traceName");
      expect(columnIds).toContain("userId");
      expect(columnIds).toContain("sessionId");
      expect(columnIds).toContain("tags");

      expect(columnIds).toContain("experimentDatasetId");

      // Metadata
      expect(columnIds).toContain("metadata");
    });
  });

  describe("variable columns alignment", () => {
    it("should have all variable column IDs present in schema", () => {
      const schemaKeys = Object.keys(observationForEvalSchema.shape);

      for (const column of observationEvalVariableColumns) {
        expect(schemaKeys).toContain(column.internal);
      }
    });

    it("should include expected variable columns", () => {
      const columnInternals = observationEvalVariableColumns.map(
        (c) => c.internal,
      );

      // Primary data fields
      expect(columnInternals).toContain("input");
      expect(columnInternals).toContain("output");
      expect(columnInternals).toContain("metadata");
      expect(columnInternals).toContain("experiment_item_expected_output");
    });
  });
});
