import * as NodeURL from "node:url";
import { defineConfig, type UserConfig } from "vite-plus";

import appConfig from "./vite.config";

// Builds only the Visual benchmark page with the app's production pipeline
// (React Compiler, Tailwind, production React). Used by
// `scripts/latex-visual-benchmark.ts`; never part of the shipped app.
export default defineConfig(async (env) => {
  const resolved: UserConfig = {
    ...(await (typeof appConfig === "function" ? appConfig(env) : appConfig)),
  };
  delete resolved.test;
  resolved.build = {
    ...resolved.build,
    outDir: process.env.SCIENT_LATEX_BENCHMARK_OUT ?? "dist-latex-benchmark",
    manifest: false,
    sourcemap: false,
    // Readable stacks attribute scroll writes and profiles; minification is
    // not a meaningful runtime cost for these measurements.
    minify: false,
    rolldownOptions: {
      input: {
        benchmark: NodeURL.fileURLToPath(new URL("./latex-visual-benchmark.html", import.meta.url)),
      },
    },
  };
  return resolved;
});
