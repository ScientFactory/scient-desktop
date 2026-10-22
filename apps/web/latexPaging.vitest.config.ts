import * as NodeURL from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite-plus/test/config";
import { tailwindPlugins } from "./vite/tailwind";

export default defineConfig({
  // A run qualifies its loaded modules even when another app shares this checkout.
  server: { watch: null },
  plugins: [react(), tailwindPlugins(false)],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("./src", import.meta.url)) } },
  optimizeDeps: { include: ["mathlive/ssr"] },
  test: {
    include: [
      "src/scient/latex/latexPagedPresentation.browser.test.tsx",
      "src/scient/latex/latexDocumentObjectSelection.browser.test.ts",
      "src/scient/latex/LatexDocumentSettings.browser.test.tsx",
      "src/scient/latex/latexVisualStability.browser.test.tsx",
      "src/scient/latex/latexSelectionSession.browser.test.ts",
      "src/scient/latex/mathFieldMountQueue.browser.test.ts",
      "src/scient/latex/latexNestedSelection.browser.test.tsx",
    ],
    fileParallelism: false,
    testTimeout: 30000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
