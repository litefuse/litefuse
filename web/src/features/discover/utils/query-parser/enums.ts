// @ts-nocheck
export enum JSDataType {
  Array = "array",
  Date = "date",
  Map = "map",
  Number = "number",
  String = "string",
  Tuple = "tuple",
  Bool = "bool",
  JSON = "json",
  Dynamic = "dynamic", // json type will store anything as Dynamic type by default
}

export const convertCHDataTypeToJSType = (
  dataType: string,
): JSDataType | null => {
  if (dataType.startsWith("Date")) {
    return JSDataType.Date;
  } else if (dataType.startsWith("Tuple")) {
    return JSDataType.Tuple;
  } else if (dataType.startsWith("Map")) {
    return JSDataType.Map;
  } else if (dataType.startsWith("Array")) {
    return JSDataType.Array;
  } else if (
    dataType.startsWith("Int") ||
    dataType.startsWith("UInt") ||
    dataType.startsWith("Float") ||
    // Nullable types are possible (charts)
    dataType.startsWith("Nullable(Int") ||
    dataType.startsWith("Nullable(UInt") ||
    dataType.startsWith("Nullable(Float")
  ) {
    return JSDataType.Number;
  } else if (
    dataType.startsWith("String") ||
    dataType.startsWith("FixedString") ||
    dataType.startsWith("Enum") ||
    dataType.startsWith("UUID") ||
    dataType.startsWith("IPv4") ||
    dataType.startsWith("IPv6")
  ) {
    return JSDataType.String;
  } else if (dataType === "Bool") {
    return JSDataType.Bool;
  } else if (dataType.startsWith("JSON")) {
    return JSDataType.JSON;
  } else if (dataType.startsWith("Dynamic")) {
    return JSDataType.Dynamic;
  } else if (dataType.startsWith("LowCardinality")) {
    return convertCHDataTypeToJSType(dataType.slice(15, -1));
  }

  return null;
};

export const convertCHTypeToPrimitiveJSType = (dataType: string) => {
  const jsType = convertCHDataTypeToJSType(dataType);

  if (
    jsType === JSDataType.Map ||
    jsType === JSDataType.Array ||
    jsType === JSDataType.Tuple
  ) {
    throw new Error("Map, Array or Tuple type is not a primitive type");
  } else if (jsType === JSDataType.Date) {
    return JSDataType.Number;
  }

  return jsType;
};
