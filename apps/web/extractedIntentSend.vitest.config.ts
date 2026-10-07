import { defineConfig } from "vite-plus";
export default defineConfig({
  test: {
    include: ["e2e/extractedIntentSend.spec.ts"],
    maxWorkers: 1,
    testTimeout: 180000,
    hookTimeout: 15000,
  },
});
