// @effect-diagnostics nodeBuiltinImport:off - synthetic paths only; no app runtime is involved.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { TestSpecification } from "vite-plus/test/node";

import shardWeights from "./shardWeights.json" with { type: "json" };
import { WeightedShardSequencer } from "./weightedShardSequencer";

const root = NodePath.resolve("web-shard-fixture");
const specs = (paths: string[]) =>
  paths.map((path) => ({ moduleId: NodePath.join(root, path) })) as TestSpecification[];
const shard = async (files: TestSpecification[], index: number, count = 3) => {
  const context = { config: { root, shard: { index, count } } } as ConstructorParameters<
    typeof WeightedShardSequencer
  >[0];
  return new WeightedShardSequencer(context).shard(files);
};
const names = (files: TestSpecification[]) => files.map((file) => file.moduleId).toSorted();

describe("web duration-weighted CI shards", () => {
  it("partitions both projects exactly once independently of discovery order", async () => {
    const files = specs([
      ...Object.keys(shardWeights),
      "src/new-unit.test.ts",
      "src/new-component.browser.test.tsx",
    ]);
    const shards = await Promise.all([1, 2, 3].map((index) => shard(files, index)));
    expect(names(shards.flat())).toEqual(names(files));
    expect(new Set(shards.flat()).size).toBe(files.length);
    for (const index of [1, 2, 3]) {
      expect(names(await shard(files.toReversed(), index))).toEqual(names(shards[index - 1]!));
    }
  });

  it("gives the three slowest browser files separate runners and balances unknown files", async () => {
    const slowest = Object.entries(shardWeights)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([path]) => path);
    const known = specs(slowest);
    for (const index of [1, 2, 3]) expect(await shard(known, index)).toHaveLength(1);

    const unknown = specs(Array.from({ length: 12 }, (_, i) => `src/new-${i}.test.ts`));
    for (const index of [1, 2, 3]) {
      expect(await shard(unknown, index)).toHaveLength(4);
      expect(names(await shard(unknown.toReversed(), index))).toEqual(
        names(await shard(unknown, index)),
      );
    }
    expect(names(await shard(unknown, 1, 1))).toEqual(names(unknown));
  });
});
