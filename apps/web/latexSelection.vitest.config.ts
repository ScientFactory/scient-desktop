import * as NodeURL from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite-plus/test/config";

// Qualify the real editing adapters without loading app routes or live profiles.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ["src/scient/latex/latexNestedSelection*.browser.test.tsx"] },
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/scient/latex/latexNestedSelection*.browser.test.tsx"],
    testTimeout: 15000,
    // Native keyboard input shares the browser tab; qualify one fixture at a time.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
