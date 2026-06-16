process.loadEnvFile?.("../../.env.test");
process.loadEnvFile?.("../../.env");

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.unit.test.ts"],
  },
});
