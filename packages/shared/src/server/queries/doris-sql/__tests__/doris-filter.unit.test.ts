import { describe, it, expect } from "vitest";
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

describe("StringFilter", () => {
  it("should generate = query", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "=",
      value: "my-trace",
    });
    const result = filter.apply();
    expect(result.query).toBe("name = 'my-trace'");
    expect(result.params).toEqual({});
  });

  it("should generate contains query using INSTR", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "contains",
      value: "test",
    });
    expect(filter.apply().query).toBe("INSTR(name, 'test') > 0");
  });

  it("should generate does not contain query", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "does not contain",
      value: "bad",
    });
    expect(filter.apply().query).toBe("INSTR(name, 'bad') = 0");
  });

  it("should generate starts with query", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "starts with",
      value: "pre",
    });
    expect(filter.apply().query).toBe("STARTS_WITH(name, 'pre')");
  });

  it("should generate ends with query", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "ends with",
      value: "fix",
    });
    expect(filter.apply().query).toBe("ENDS_WITH(name, 'fix')");
  });

  it("should escape single quotes in values", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "=",
      value: "it's",
    });
    expect(filter.apply().query).toBe("name = 'it''s'");
  });

  it("should apply table prefix", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "=",
      value: "test",
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("t.name = 'test'");
  });

  it("should apply table prefix to contains", () => {
    const filter = new StringFilter({
      table: "traces",
      field: "name",
      operator: "contains",
      value: "test",
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("INSTR(t.name, 'test') > 0");
  });
});

describe("NumberFilter", () => {
  it("should generate > query", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: ">",
      value: 0.5,
    });
    expect(filter.apply().query).toBe("value > 0.5");
  });

  it("should generate < query", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: "<",
      value: 100,
    });
    expect(filter.apply().query).toBe("value < 100");
  });

  it("should generate = query", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: "=",
      value: 42,
    });
    expect(filter.apply().query).toBe("value = 42");
  });

  it("should generate != query", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: "!=",
      value: 0,
    });
    expect(filter.apply().query).toBe("value != 0");
  });

  it("should generate >= query", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: ">=",
      value: 10,
    });
    expect(filter.apply().query).toBe("value >= 10");
  });

  it("should generate <= query", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: "<=",
      value: 99,
    });
    expect(filter.apply().query).toBe("value <= 99");
  });

  it("should apply table prefix", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: ">",
      value: 5,
      tablePrefix: "s",
    });
    expect(filter.apply().query).toBe("s.value > 5");
  });

  it("should handle zero value", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: "=",
      value: 0,
    });
    expect(filter.apply().query).toBe("value = 0");
  });

  it("should handle negative value", () => {
    const filter = new NumberFilter({
      table: "scores",
      field: "value",
      operator: ">",
      value: -1,
    });
    expect(filter.apply().query).toBe("value > -1");
  });
});

describe("DateTimeFilter", () => {
  it("should generate > query with UTC format", () => {
    const date = new Date("2024-01-15T10:30:00.500Z");
    const filter = new DateTimeFilter({
      table: "traces",
      field: "timestamp",
      operator: ">",
      value: date,
    });
    expect(filter.apply().query).toBe("timestamp > '2024-01-15 10:30:00.500'");
  });

  it("should generate < query", () => {
    const date = new Date("2024-12-31T23:59:59.999Z");
    const filter = new DateTimeFilter({
      table: "traces",
      field: "timestamp",
      operator: "<",
      value: date,
    });
    expect(filter.apply().query).toBe("timestamp < '2024-12-31 23:59:59.999'");
  });

  it("should generate >= query", () => {
    const date = new Date("2024-06-01T00:00:00.000Z");
    const filter = new DateTimeFilter({
      table: "traces",
      field: "timestamp",
      operator: ">=",
      value: date,
    });
    expect(filter.apply().query).toBe("timestamp >= '2024-06-01 00:00:00.000'");
  });

  it("should generate <= query", () => {
    const date = new Date("2024-06-30T23:59:59.000Z");
    const filter = new DateTimeFilter({
      table: "traces",
      field: "timestamp",
      operator: "<=",
      value: date,
    });
    expect(filter.apply().query).toBe("timestamp <= '2024-06-30 23:59:59.000'");
  });

  it("should apply table prefix", () => {
    const date = new Date("2024-01-01T00:00:00.000Z");
    const filter = new DateTimeFilter({
      table: "traces",
      field: "timestamp",
      operator: ">",
      value: date,
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe(
      "t.timestamp > '2024-01-01 00:00:00.000'",
    );
  });
});

describe("StringOptionsFilter", () => {
  it("should generate any of (IN) query", () => {
    const filter = new StringOptionsFilter({
      table: "traces",
      field: "name",
      operator: "any of",
      values: ["trace-a", "trace-b"],
    });
    expect(filter.apply().query).toBe("name IN ('trace-a', 'trace-b')");
  });

  it("should generate none of (NOT IN) query", () => {
    const filter = new StringOptionsFilter({
      table: "traces",
      field: "name",
      operator: "none of",
      values: ["bad-trace"],
    });
    expect(filter.apply().query).toBe("name NOT IN ('bad-trace')");
  });

  it("should escape single quotes in values", () => {
    const filter = new StringOptionsFilter({
      table: "traces",
      field: "name",
      operator: "any of",
      values: ["it's", "they're"],
    });
    expect(filter.apply().query).toBe("name IN ('it''s', 'they''re')");
  });

  it("should apply table prefix", () => {
    const filter = new StringOptionsFilter({
      table: "traces",
      field: "name",
      operator: "any of",
      values: ["a"],
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("t.name IN ('a')");
  });
});

describe("BooleanFilter", () => {
  it("should generate = TRUE query", () => {
    const filter = new BooleanFilter({
      table: "traces",
      field: "public",
      operator: "=",
      value: true,
    });
    expect(filter.apply().query).toBe("public = TRUE");
  });

  it("should generate = FALSE query", () => {
    const filter = new BooleanFilter({
      table: "traces",
      field: "public",
      operator: "=",
      value: false,
    });
    expect(filter.apply().query).toBe("public = FALSE");
  });

  it("should generate <> TRUE query", () => {
    const filter = new BooleanFilter({
      table: "traces",
      field: "public",
      operator: "<>",
      value: true,
    });
    expect(filter.apply().query).toBe("public <> TRUE");
  });

  it("should apply table prefix", () => {
    const filter = new BooleanFilter({
      table: "traces",
      field: "public",
      operator: "=",
      value: true,
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("t.public = TRUE");
  });
});

describe("NullFilter", () => {
  it("should generate IS NULL query", () => {
    const filter = new NullFilter({
      table: "traces",
      field: "name",
      operator: "is null",
    });
    expect(filter.apply().query).toBe("name is null");
  });

  it("should generate IS NOT NULL query", () => {
    const filter = new NullFilter({
      table: "traces",
      field: "name",
      operator: "is not null",
    });
    expect(filter.apply().query).toBe("name is not null");
  });

  it("should apply table prefix", () => {
    const filter = new NullFilter({
      table: "traces",
      field: "name",
      operator: "is null",
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("t.name is null");
  });
});

describe("ArrayOptionsFilter", () => {
  it("should generate any of query using ARRAY_OVERLAP", () => {
    const filter = new ArrayOptionsFilter({
      table: "traces",
      field: "tags",
      operator: "any of",
      values: ["tag1", "tag2"],
    });
    expect(filter.apply().query).toBe(
      "ARRAY_OVERLAP(tags, ARRAY['tag1', 'tag2'])",
    );
  });

  it("should generate none of query", () => {
    const filter = new ArrayOptionsFilter({
      table: "traces",
      field: "tags",
      operator: "none of",
      values: ["bad"],
    });
    expect(filter.apply().query).toBe("NOT ARRAY_OVERLAP(tags, ARRAY['bad'])");
  });

  it("should generate all of query using ARRAY_CONTAINS", () => {
    const filter = new ArrayOptionsFilter({
      table: "traces",
      field: "tags",
      operator: "all of",
      values: ["tag1", "tag2"],
    });
    expect(filter.apply().query).toBe(
      "(ARRAY_CONTAINS(tags, 'tag1') AND ARRAY_CONTAINS(tags, 'tag2'))",
    );
  });

  it("should escape single quotes in array values", () => {
    const filter = new ArrayOptionsFilter({
      table: "traces",
      field: "tags",
      operator: "any of",
      values: ["it's"],
    });
    expect(filter.apply().query).toBe("ARRAY_OVERLAP(tags, ARRAY['it''s'])");
  });

  it("should apply table prefix", () => {
    const filter = new ArrayOptionsFilter({
      table: "traces",
      field: "tags",
      operator: "any of",
      values: ["a"],
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("ARRAY_OVERLAP(t.tags, ARRAY['a'])");
  });
});

describe("CategoryOptionsFilter", () => {
  it("should flatten key:value and generate any of query", () => {
    const filter = new CategoryOptionsFilter({
      table: "scores",
      field: "score_categories",
      operator: "any of",
      key: "sentiment",
      values: ["positive", "neutral"],
    });
    expect(filter.apply().query).toBe(
      "ARRAY_OVERLAP(score_categories, ['sentiment:positive', 'sentiment:neutral'])",
    );
  });

  it("should generate none of query", () => {
    const filter = new CategoryOptionsFilter({
      table: "scores",
      field: "score_categories",
      operator: "none of",
      key: "quality",
      values: ["bad"],
    });
    expect(filter.apply().query).toBe(
      "NOT ARRAY_OVERLAP(score_categories, ['quality:bad'])",
    );
  });

  it("should escape single quotes in key:value", () => {
    const filter = new CategoryOptionsFilter({
      table: "scores",
      field: "score_categories",
      operator: "any of",
      key: "user's",
      values: ["it's"],
    });
    expect(filter.apply().query).toBe(
      "ARRAY_OVERLAP(score_categories, ['user''s:it''s'])",
    );
  });

  it("should apply table prefix", () => {
    const filter = new CategoryOptionsFilter({
      table: "scores",
      field: "score_categories",
      operator: "any of",
      key: "k",
      values: ["v"],
      tablePrefix: "s",
    });
    expect(filter.apply().query).toBe(
      "ARRAY_OVERLAP(s.score_categories, ['k:v'])",
    );
  });
});

describe("StringObjectFilter", () => {
  it("should generate = query with MAP access", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "=",
      key: "env",
      value: "production",
    });
    expect(filter.apply().query).toBe("metadata['env'] = 'production'");
  });

  it("should generate contains query with MAP access", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "contains",
      key: "env",
      value: "prod",
    });
    expect(filter.apply().query).toBe("INSTR(metadata['env'], 'prod') > 0");
  });

  it("should generate does not contain query", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "does not contain",
      key: "env",
      value: "test",
    });
    expect(filter.apply().query).toBe("INSTR(metadata['env'], 'test') = 0");
  });

  it("should generate starts with query", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "starts with",
      key: "env",
      value: "pro",
    });
    expect(filter.apply().query).toBe("STARTS_WITH(metadata['env'], 'pro')");
  });

  it("should generate ends with query", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "ends with",
      key: "env",
      value: "tion",
    });
    expect(filter.apply().query).toBe("ENDS_WITH(metadata['env'], 'tion')");
  });

  it("should escape single quotes in key and value", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "=",
      key: "user's",
      value: "it's",
    });
    expect(filter.apply().query).toBe("metadata['user''s'] = 'it''s'");
  });

  it("should apply table prefix", () => {
    const filter = new StringObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "=",
      key: "env",
      value: "prod",
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe("t.metadata['env'] = 'prod'");
  });
});

describe("NumberObjectFilter", () => {
  it("should generate = query with CAST to DECIMAL", () => {
    const filter = new NumberObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "=",
      key: "score",
      value: 42,
    });
    expect(filter.apply().query).toBe(
      "CAST(metadata['score'] AS DECIMAL(20,6)) = 42",
    );
  });

  it("should generate > query", () => {
    const filter = new NumberObjectFilter({
      table: "traces",
      field: "metadata",
      operator: ">",
      key: "score",
      value: 0.5,
    });
    expect(filter.apply().query).toBe(
      "CAST(metadata['score'] AS DECIMAL(20,6)) > 0.5",
    );
  });

  it("should generate < query", () => {
    const filter = new NumberObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "<",
      key: "count",
      value: 100,
    });
    expect(filter.apply().query).toBe(
      "CAST(metadata['count'] AS DECIMAL(20,6)) < 100",
    );
  });

  it("should generate != query", () => {
    const filter = new NumberObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "!=",
      key: "version",
      value: 0,
    });
    expect(filter.apply().query).toBe(
      "CAST(metadata['version'] AS DECIMAL(20,6)) != 0",
    );
  });

  it("should escape single quotes in key", () => {
    const filter = new NumberObjectFilter({
      table: "traces",
      field: "metadata",
      operator: "=",
      key: "user's score",
      value: 10,
    });
    expect(filter.apply().query).toBe(
      "CAST(metadata['user''s score'] AS DECIMAL(20,6)) = 10",
    );
  });

  it("should apply table prefix", () => {
    const filter = new NumberObjectFilter({
      table: "traces",
      field: "metadata",
      operator: ">",
      key: "score",
      value: 5,
      tablePrefix: "t",
    });
    expect(filter.apply().query).toBe(
      "CAST(t.metadata['score'] AS DECIMAL(20,6)) > 5",
    );
  });
});
