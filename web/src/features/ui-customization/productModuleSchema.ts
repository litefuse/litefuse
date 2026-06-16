/**
 * Plain type aliases preserved from the EE UI customization feature so that the
 * navigation route table can keep using the `ProductModule` union. The OSS
 * distribution does not let operators toggle modules at runtime, but knowing the
 * set of well-known modules is still useful for the route definitions below.
 */
export const PRODUCT_MODULES = [
  "dashboards",
  "tracing",
  "evaluation",
  "prompt-management",
  "playground",
  "datasets",
] as const;

export type ProductModule = (typeof PRODUCT_MODULES)[number];
