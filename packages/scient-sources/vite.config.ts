import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    // The killed-process tests start child processes; the repository's ceiling applies here too.
    testTimeout: 60_000,
  },
});
