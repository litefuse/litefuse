import { describe, it, expect, vi } from "vitest";

// Mock the analytics repository to avoid pulling in axios/mysql2 via client.ts
vi.mock("../../repositories/analytics", () => ({
  convertDateToAnalyticsDateTime: (date: Date) =>
    date.toISOString().replace("T", " ").replace("Z", ""),
}));

import { DorisParameterProcessor } from "../parameterProcessor";

describe("DorisParameterProcessor", () => {
  describe("processQuery with typed params", () => {
    it("should replace String typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE name = {name: String}",
        { name: "test-trace" },
      );
      expect(result).toBe("SELECT * FROM traces WHERE name = 'test-trace'");
    });

    it("should replace Int64 typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM scores WHERE value = {val: Int64}",
        { val: 42 },
      );
      expect(result).toBe("SELECT * FROM scores WHERE value = 42");
    });

    it("should replace DateTime64(3) typed parameter", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE timestamp > {ts: DateTime64(3)}",
        { ts: date },
      );
      expect(result).toBe(
        "SELECT * FROM traces WHERE timestamp > '2024-01-15 10:30:00.000'",
      );
    });

    it("should replace Array(String) typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE id IN ({ids: Array(String)})",
        { ids: ["id1", "id2", "id3"] },
      );
      expect(result).toBe(
        "SELECT * FROM traces WHERE id IN ('id1', 'id2', 'id3')",
      );
    });

    it("should replace Boolean typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE public = {flag: Boolean}",
        { flag: true },
      );
      expect(result).toBe("SELECT * FROM traces WHERE public = TRUE");
    });

    it("should replace Boolean false typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE public = {flag: Boolean}",
        { flag: false },
      );
      expect(result).toBe("SELECT * FROM traces WHERE public = FALSE");
    });

    it("should replace Float64 typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM scores WHERE value > {threshold: Float64}",
        { threshold: 0.95 },
      );
      expect(result).toBe("SELECT * FROM scores WHERE value > 0.95");
    });

    it("should replace Decimal64(12) typed parameter", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM scores WHERE cost = {amount: Decimal64(12)}",
        { amount: 123.456 },
      );
      expect(result).toBe("SELECT * FROM scores WHERE cost = 123.456");
    });
  });

  describe("processQuery with simple params", () => {
    it("should replace simple parameter with string value", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE project_id = {projectId}",
        { projectId: "proj-123" },
      );
      expect(result).toBe("SELECT * FROM traces WHERE project_id = 'proj-123'");
    });

    it("should replace simple parameter with number value", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces LIMIT {limit}",
        { limit: 100 },
      );
      expect(result).toBe("SELECT * FROM traces LIMIT 100");
    });

    it("should replace simple parameter with boolean value", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE active = {active}",
        { active: true },
      );
      expect(result).toBe("SELECT * FROM traces WHERE active = TRUE");
    });
  });

  describe("processQuery edge cases", () => {
    it("should return query unchanged when no params provided", () => {
      const query = "SELECT * FROM traces";
      expect(DorisParameterProcessor.processQuery(query)).toBe(query);
      expect(DorisParameterProcessor.processQuery(query, {})).toBe(query);
    });

    it("should leave unmatched typed params unchanged", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE name = {name: String} AND id = {id: String}",
        { name: "test" },
      );
      expect(result).toBe(
        "SELECT * FROM traces WHERE name = 'test' AND id = {id: String}",
      );
    });

    it("should leave unmatched simple params unchanged", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE a = {a} AND b = {b}",
        { a: "val" },
      );
      expect(result).toBe("SELECT * FROM traces WHERE a = 'val' AND b = {b}");
    });

    it("should handle multiple params in one query", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE project_id = {pid: String} AND name = {name: String} LIMIT {limit}",
        { pid: "proj-1", name: "trace-a", limit: 50 },
      );
      expect(result).toBe(
        "SELECT * FROM traces WHERE project_id = 'proj-1' AND name = 'trace-a' LIMIT 50",
      );
    });
  });

  describe("formatValue edge cases", () => {
    it("should return NULL for null value", () => {
      expect(DorisParameterProcessor.formatValue(null, "String")).toBe("NULL");
    });

    it("should return NULL for undefined value", () => {
      expect(DorisParameterProcessor.formatValue(undefined, "String")).toBe(
        "NULL",
      );
    });

    it("should return NULL for NaN numeric value", () => {
      expect(DorisParameterProcessor.formatValue(NaN, "Int64")).toBe("NULL");
    });

    it("should return NULL for Infinity numeric value", () => {
      expect(DorisParameterProcessor.formatValue(Infinity, "Float64")).toBe(
        "NULL",
      );
    });

    it("should return NULL for empty array", () => {
      expect(DorisParameterProcessor.formatValue([], "Array(String)")).toBe(
        "NULL",
      );
    });

    it("should escape single quotes in string values", () => {
      expect(DorisParameterProcessor.formatValue("it's a test", "String")).toBe(
        "'it''s a test'",
      );
    });

    it("should handle numeric string for numeric type", () => {
      expect(DorisParameterProcessor.formatValue("42", "Int64")).toBe("42");
    });

    it("should return NULL for non-numeric string in numeric type", () => {
      expect(DorisParameterProcessor.formatValue("abc", "Int64")).toBe("NULL");
    });
  });

  describe("formatDateTimeValue (via formatValue)", () => {
    it("should format Date object", () => {
      const date = new Date("2024-06-15T12:00:00.500Z");
      const result = DorisParameterProcessor.formatValue(date, "DateTime64(3)");
      expect(result).toBe("'2024-06-15 12:00:00.500'");
    });

    it("should format numeric timestamp", () => {
      const timestamp = new Date("2024-06-15T12:00:00.000Z").getTime();
      const result = DorisParameterProcessor.formatValue(timestamp, "DateTime");
      expect(result).toBe("'2024-06-15 12:00:00.000'");
    });

    it("should format string date", () => {
      const result = DorisParameterProcessor.formatValue(
        "2024-06-15T12:00:00.000Z",
        "DateTime64(3)",
      );
      expect(result).toBe("'2024-06-15 12:00:00.000'");
    });

    it("should return NULL for non-date value in DateTime type", () => {
      expect(DorisParameterProcessor.formatValue({}, "DateTime64(3)")).toBe(
        "NULL",
      );
    });

    it("should handle invalid date string gracefully", () => {
      const result = DorisParameterProcessor.formatValue(
        "not-a-date",
        "DateTime64(3)",
      );
      // Falls through to string return since Date parse fails
      expect(result).toBe("'not-a-date'");
    });
  });

  describe("escapeBasicValue (via simple params)", () => {
    it("should escape SQL injection attempts in strings", () => {
      const result = DorisParameterProcessor.processQuery(
        "SELECT * FROM traces WHERE name = {name}",
        { name: "'; DROP TABLE traces; --" },
      );
      expect(result).toBe(
        "SELECT * FROM traces WHERE name = '''; DROP TABLE traces; --'",
      );
    });

    it("should handle boolean values", () => {
      const result = DorisParameterProcessor.processQuery("SELECT {val}", {
        val: false,
      });
      expect(result).toBe("SELECT FALSE");
    });

    it("should handle Date objects in simple params", () => {
      const date = new Date("2024-01-01T00:00:00.000Z");
      const result = DorisParameterProcessor.processQuery("SELECT {val}", {
        val: date,
      });
      expect(result).toBe("SELECT '2024-01-01 00:00:00.000'");
    });

    it("should handle null in simple params", () => {
      const result = DorisParameterProcessor.processQuery("SELECT {val}", {
        val: null,
      });
      // null gets replaced by escapeBasicValue → 'NULL'
      // But wait - null means the param IS in params but value is null
      // The simple param handler checks for undefined, not null
      // So null goes through escapeBasicValue which returns 'NULL'
      expect(result).toBe("SELECT NULL");
    });
  });

  describe("getSupportedTypes", () => {
    it("should return an array of supported type strings", () => {
      const types = DorisParameterProcessor.getSupportedTypes();
      expect(types).toContain("String");
      expect(types).toContain("Int64");
      expect(types).toContain("DateTime64(3)");
      expect(types).toContain("Array(String)");
      expect(types).toContain("Boolean");
      expect(types.length).toBeGreaterThan(0);
    });
  });
});
