// @ts-nocheck
import { convertColumnToRow, convertColumnToRowViaFieldsType } from "./data";

describe("discover data variant parsing", () => {
  it("keeps VARIANT object values as-is in convertColumnToRow", () => {
    const variantValue = { foo: "bar", nested: { count: 1 } };
    const frame = {
      schema: {
        fields: [
          {
            name: "payload",
            type: "VARIANT",
          },
        ],
      },
      data: {
        values: [[variantValue]],
      },
    };

    expect(() => convertColumnToRow(frame)).not.toThrow();
    expect(convertColumnToRow(frame)).toEqual([{ payload: variantValue }]);
  });

  it("parses VARIANT JSON strings in convertColumnToRow", () => {
    const frame = {
      schema: {
        fields: [
          {
            name: "payload",
            type: "VARIANT",
          },
        ],
      },
      data: {
        values: [['{"foo":"bar","nested":{"count":1}}']],
      },
    };

    expect(convertColumnToRow(frame)).toEqual([
      { payload: { foo: "bar", nested: { count: 1 } } },
    ]);
  });

  it("keeps VARIANT object values as-is in convertColumnToRowViaFieldsType", () => {
    const variantValue = { foo: "bar", nested: { count: 1 } };
    const frame = {
      schema: {
        fields: [
          {
            name: "payload",
            type: "string",
          },
        ],
      },
      data: {
        values: [[variantValue]],
      },
    };
    const fields = [
      {
        Field: "payload",
        Type: "VARIANT",
      },
    ];

    expect(() => convertColumnToRowViaFieldsType(frame, fields)).not.toThrow();
    expect(convertColumnToRowViaFieldsType(frame, fields)).toEqual([
      { payload: variantValue },
    ]);
  });

  it("parses VARIANT JSON strings in convertColumnToRowViaFieldsType", () => {
    const frame = {
      schema: {
        fields: [
          {
            name: "payload",
            type: "string",
          },
        ],
      },
      data: {
        values: [['{"foo":"bar","nested":{"count":1}}']],
      },
    };
    const fields = [
      {
        Field: "payload",
        Type: "VARIANT",
      },
    ];

    expect(convertColumnToRowViaFieldsType(frame, fields)).toEqual([
      { payload: { foo: "bar", nested: { count: 1 } } },
    ]);
  });

  it("keeps plain-text VARIANT strings without logging parse errors", () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const frame = {
      schema: {
        fields: [
          {
            name: "payload",
            type: "VARIANT",
          },
        ],
      },
      data: {
        values: [["帮我调研下一个 ai agent 产品"]],
      },
    };

    expect(convertColumnToRow(frame)).toEqual([
      { payload: "帮我调研下一个 ai agent 产品" },
    ]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
