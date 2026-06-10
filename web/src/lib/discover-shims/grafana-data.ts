/**
 * Shim for @grafana/data
 * Provides minimal replacements for Grafana data types and utilities
 * used by the discover plugin.
 */

// ---------------------------------------------------------------------------
// Enums / constants
// ---------------------------------------------------------------------------

export enum FieldType {
  time = "time",
  number = "number",
  string = "string",
  boolean = "boolean",
  other = "other",
  enum = "enum",
  geo = "geo",
  frame = "frame",
  nestedFrames = "nestedFrames",
}

export enum LoadingState {
  NotStarted = "NotStarted",
  Loading = "Loading",
  Streaming = "Streaming",
  Done = "Done",
  Error = "Error",
}

export enum PluginType {
  panel = "panel",
  datasource = "datasource",
  app = "app",
  renderer = "renderer",
  secretsmanager = "secretsmanager",
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Field<T = any> {
  name: string;
  type: FieldType | string;
  values: T[] & { get?: (index: number) => T; toArray?: () => T[] };
  config?: Record<string, any>;
  typeInfo?: any;
}

export interface DataFrame {
  name?: string;
  refId?: string;
  fields: Field[];
  length: number;
  meta?: any;
}

export interface DataSourceInstanceSettings<T = DataSourceJsonData> {
  id: number;
  uid: string;
  type: string;
  name: string;
  jsonData: T;
  meta?: any;
  url?: string;
  basicAuth?: string;
  isDefault?: boolean;
  access?: string;
}

export interface DataSourceJsonData {
  [key: string]: any;
}

export interface SelectableValue<T = any> {
  label?: string;
  value?: T;
  description?: string;
  imgUrl?: string;
  icon?: string;
  [key: string]: any;
}

export interface GrafanaTheme2 {
  isDark: boolean;
  isLight: boolean;
  colors: {
    text: { primary: string; secondary: string; disabled: string };
    background: { primary: string; secondary: string; canvas: string };
    border: { weak: string; medium: string; strong: string };
  };
}

export interface AppPluginMeta<T = {}> {
  id: string;
  name: string;
  type: PluginType;
  enabled: boolean;
  jsonData?: T;
}

export interface PluginMeta<T = {}> {
  id: string;
  name: string;
  type: PluginType;
  info: any;
  module: string;
  baseUrl: string;
  enabled: boolean;
  jsonData?: T;
}

export interface PluginConfigPageProps<T = PluginMeta> {
  meta: T;
  query: Record<string, string>;
}

export interface AppRootProps<T = {}> {
  path: string;
  query: Record<string, string>;
  meta: AppPluginMeta<T>;
  onNavChanged?: (nav: any) => void;
}

// ---------------------------------------------------------------------------
// AppPlugin stub
// ---------------------------------------------------------------------------

export class AppPlugin<T = {}> {
  setRootPage(_component: any) {
    return this;
  }
  addConfigPage(_config: any) {
    return this;
  }
}

// ---------------------------------------------------------------------------
// toDataFrame
// Converts a Grafana-format frame (schema + data) to a DataFrame-like object.
// The frame format is:
//   { schema: { fields: [{ name, type }] }, data: { values: [[...], [...]] } }
// ---------------------------------------------------------------------------

export function toDataFrame(frame: any): DataFrame {
  if (!frame) {
    return { fields: [], length: 0 };
  }

  const schemaFields: Array<{ name: string; type: string }> =
    frame.schema?.fields ?? [];
  const dataValues: any[][] = frame.data?.values ?? [];

  const fields: Field[] = schemaFields.map((f, i) => ({
    name: f.name,
    type: f.type as FieldType,
    // Wrap the raw array so callers can use Array.from(field.values)
    // and also field.values.get(idx) – both patterns appear in the codebase.
    values: createVectorLike(dataValues[i] ?? []),
    config: {},
  }));

  return {
    refId: frame.schema?.refId,
    fields,
    length: dataValues[0]?.length ?? 0,
  };
}

/**
 * Returns an array-like object that also exposes a `.get(index)` method,
 * matching the Grafana `Vector` interface used in several places.
 */
function createVectorLike<T>(arr: T[]): any {
  const proxy = new Proxy(arr as any, {
    get(target, prop) {
      if (prop === "get") {
        return (index: number) => target[index];
      }
      if (prop === "toArray") {
        return () => [...target];
      }
      return target[prop as any];
    },
  });
  return proxy;
}
