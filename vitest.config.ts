import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        statements: 88,
        branches: 85,
        functions: 91,
        lines: 88,
      },
    },
  },
});
