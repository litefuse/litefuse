import { describe, it, expect, vi } from "vitest";

// Mock logger to suppress debug output
vi.mock("../../../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  createDorisFilterFromFilterState,
  QueryBuilderError,
} from "../factory";
import {
  StringFilter,
  NumberFilter,
  DateTimeFilter,
  StringOptionsFilter,
  BooleanFilter,
  NullFilter,
  ArrayOptionsFilter,
  CategoryOptionsFilter,
  StringObjectFilter,
  NumberObjectFilter,
} from "../doris-filter";
import type { UiColumnMappings } from "../../../../tableDefinitions";
import type { FilterCondition } from "../../../../types";

// Test column mapping that uses valid ClickHouse table names
const testColumnMappings: UiColumnMappings = [
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "traces",
    select: "name",
    queryPrefix: "t",
  },
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "traces",
    select: "timestamp",
    queryPrefix: "t",
  },
  {
    uiTableName: "Tags",
    uiTableId: "tags",
    tableName: "traces",
    select: "tags",
    queryPrefix: "t",
  },
  {
    uiTableName: "Public",
    uiTableId: "public",
    tableName: "traces",
    select: "public",
    queryPrefix: "t",
  },
  {
    uiTableName: "Value",
    uiTableId: "value",
    tableName: "scores",
    select: "value",
    queryPrefix: "s",
  },
  {
    uiTableName: "Score Categories",
    uiTableId: "score_categories",
    tableName: "scores",
    select: "score_categories",
    queryPrefix: "s",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "traces",
    select: "metadata",
    queryPrefix: "t",
  },
  {
    uiTableName: "Status",
    uiTableId: "status",
    tableName: "traces",
    select: "status",
    queryPrefix: "t",
  },
] as const;

const eventsFullColumnMappings: UiColumnMappings = [
  {
    uiTableName: "Start Time",
    uiTableId: "startTime",
    tableName: "observations",
    select: "o.start_time",
    queryPrefix: "o",
  },
] as const;

describe("createDorisFilterFromFilterState", () => {
  describe("filter type mapping", () => {
    it("should map string filter to StringFilter", () => {
      const filters: FilterCondition[] = [
        { column: "name", operator: "=", value: "test", type: "string" },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(StringFilter);
    });

    it("should map datetime filter to DateTimeFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "timestamp",
          operator: ">",
          value: new Date("2024-01-01"),
          type: "datetime",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(DateTimeFilter);
    });

    it("should map number filter to NumberFilter", () => {
      const filters: FilterCondition[] = [
        { column: "value", operator: ">", value: 0.5, type: "number" },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(NumberFilter);
    });

    it("should map stringOptions filter to StringOptionsFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "status",
          operator: "any of",
          value: ["active"],
          type: "stringOptions",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(StringOptionsFilter);
    });

    it("should map boolean filter to BooleanFilter", () => {
      const filters: FilterCondition[] = [
        { column: "public", operator: "=", value: true, type: "boolean" },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(BooleanFilter);
    });

    it("should map null filter to NullFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "name",
          operator: "is null",
          type: "null",
          value: "" as const,
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(NullFilter);
    });

    it("should map arrayOptions filter to ArrayOptionsFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "tags",
          operator: "any of",
          value: ["tag1"],
          type: "arrayOptions",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(ArrayOptionsFilter);
    });

    it("should map categoryOptions filter to CategoryOptionsFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "score_categories",
          operator: "any of",
          key: "sentiment",
          value: ["positive"],
          type: "categoryOptions",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(CategoryOptionsFilter);
    });

    it("should map stringObject filter to StringObjectFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "metadata",
          operator: "=",
          key: "env",
          value: "prod",
          type: "stringObject",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(StringObjectFilter);
    });

    it("should map numberObject filter to NumberObjectFilter", () => {
      const filters: FilterCondition[] = [
        {
          column: "metadata",
          operator: ">",
          key: "score",
          value: 0.5,
          type: "numberObject",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result[0]).toBeInstanceOf(NumberObjectFilter);
    });
  });

  describe("positionInTrace exclusion", () => {
    it("should exclude positionInTrace filter type", () => {
      const filters: FilterCondition[] = [
        { column: "name", operator: "=", value: "test", type: "string" },
        {
          column: "name",
          operator: "=",
          value: "1",
          type: "positionInTrace",
        } as any,
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(StringFilter);
    });
  });

  describe("column lookup", () => {
    it("should find column by uiTableName", () => {
      const filters: FilterCondition[] = [
        { column: "Name", operator: "=", value: "test", type: "string" },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result).toHaveLength(1);
    });

    it("should find column by uiTableId", () => {
      const filters: FilterCondition[] = [
        { column: "name", operator: "=", value: "test", type: "string" },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result).toHaveLength(1);
    });

    it("should allow observations mappings backed by events_full queries", () => {
      const filters: FilterCondition[] = [
        {
          column: "startTime",
          operator: "<",
          value: new Date("2026-06-23T00:00:00.000Z"),
          type: "datetime",
        },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        eventsFullColumnMappings,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(DateTimeFilter);
    });
  });

  describe("error cases", () => {
    it("should throw QueryBuilderError for invalid column name", () => {
      const filters: FilterCondition[] = [
        {
          column: "nonexistent_column",
          operator: "=",
          value: "test",
          type: "string",
        },
      ];
      expect(() =>
        createDorisFilterFromFilterState(filters, testColumnMappings),
      ).toThrow(QueryBuilderError);
    });

    it("should throw QueryBuilderError for invalid table name in column mapping", () => {
      const badMapping: UiColumnMappings = [
        {
          uiTableName: "Bad",
          uiTableId: "bad",
          tableName: "invalid_table_name",
          select: "bad",
        },
      ] as const;
      const filters: FilterCondition[] = [
        { column: "bad", operator: "=", value: "test", type: "string" },
      ];
      expect(() =>
        createDorisFilterFromFilterState(filters, badMapping),
      ).toThrow(QueryBuilderError);
    });
  });

  describe("multiple filters", () => {
    it("should process multiple filters correctly", () => {
      const filters: FilterCondition[] = [
        { column: "name", operator: "=", value: "test", type: "string" },
        {
          column: "timestamp",
          operator: ">",
          value: new Date("2024-01-01"),
          type: "datetime",
        },
        { column: "value", operator: ">", value: 0.5, type: "number" },
      ];
      const result = createDorisFilterFromFilterState(
        filters,
        testColumnMappings,
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toBeInstanceOf(StringFilter);
      expect(result[1]).toBeInstanceOf(DateTimeFilter);
      expect(result[2]).toBeInstanceOf(NumberFilter);
    });
  });
});
