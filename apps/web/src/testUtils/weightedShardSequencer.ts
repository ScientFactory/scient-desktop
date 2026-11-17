// @effect-diagnostics nodeBuiltinImport:off - Vitest loads this outside the app runtime.
import * as NodePath from "node:path";

import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

import shardWeights from "./shardWeights.json" with { type: "json" };

const recordedSeconds: Readonly<Record<string, number>> = shardWeights;
const UNRECORDED_FILE_SECONDS = 1;
// Measured on CI shards: a browser file loads its module graph for 2-4 s before its first test,
// which its recorded duration leaves out.
const BROWSER_FILE_LOAD_SECONDS = 2.5;

/** Longest-first allocation across both web projects, counting browser files' load time. */
export class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const weighted = files
      .map((spec) => {
        const key = NodePath.relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
        const recorded = recordedSeconds[key] ?? UNRECORDED_FILE_SECONDS;
        const load = /\.browser\.test\.tsx?$/u.test(key) ? BROWSER_FILE_LOAD_SECONDS : 0;
        return { spec, key, seconds: recorded + load };
      })
      .toSorted((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const loads = Array.from({ length: count }, () => 0);
    const picked: TestSpecification[] = [];
    for (const file of weighted) {
      const least = Math.min(...loads);
      const lightest = loads.indexOf(least);
      loads[lightest] = least + file.seconds;
      if (lightest === index - 1) picked.push(file.spec);
    }
    return picked;
  }
}
