import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));
const envTestPath = fileURLToPath(new URL("../.env.test", import.meta.url));
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(envTestPath)) {
  process.loadEnvFile?.(envTestPath);
}
if (existsSync(envPath)) {
  process.loadEnvFile?.(envPath);
}

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/worker/**/*.test.ts"],
  },
});
