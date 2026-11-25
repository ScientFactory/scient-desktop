// @effect-diagnostics nodeBuiltinImport:off - Vitest loads this sequencer from the config,
// outside any Effect runtime, and only needs path.relative.
import * as NodePath from "node:path";

import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

// The longest file in the package by far; its project sorts after `react`, so it otherwise
// starts last and runs alone at the end of its shard.
const COMPILER_SWEEP = "src/reactCompilerCoverage.test.ts";

/** Vitest's own order and shards, with the React Compiler sweep started first in its shard. */
export class ReactCompilerFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    const sorted = await super.sort(files);
    const sweep = (spec: TestSpecification) =>
      NodePath.relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/") ===
      COMPILER_SWEEP;
    return [...sorted.filter(sweep), ...sorted.filter((spec) => !sweep(spec))];
  }
}
