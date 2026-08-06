import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/web/**/*.test.ts", "src/web/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
