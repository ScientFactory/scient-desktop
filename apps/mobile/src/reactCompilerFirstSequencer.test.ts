// @effect-diagnostics nodeBuiltinImport:off - synthetic paths only; no app runtime is involved.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

import { ReactCompilerFirstSequencer } from "./reactCompilerFirstSequencer";

const root = NodePath.resolve("mobile-sequencer-fixture");
const spec = (project: string, path: string) =>
  ({
    moduleId: NodePath.join(root, path),
    project: { name: project, config: { sequence: { groupOrder: 0 }, isolate: true } },
  }) as unknown as TestSpecification;
const context = (count = 1, index = 1) =>
  ({
    config: { root, shard: { index, count } },
    cache: { getTestSpecificationResult: () => undefined },
  }) as unknown as ConstructorParameters<typeof ReactCompilerFirstSequencer>[0];
const sequencer = (count = 1, index = 1) => new ReactCompilerFirstSequencer(context(count, index));
const paths = (files: TestSpecification[]) =>
  files.map((file) => NodePath.relative(root, file.moduleId));

describe("mobile test order", () => {
  it("starts the React Compiler sweep first and keeps every other file in Vitest's order", async () => {
    const files = [
      spec("unit", "src/a.test.ts"),
      spec("react", "src/b.test.tsx"),
      spec("unit", "src/reactCompilerCoverage.test.ts"),
      spec("react", "src/c.test.tsx"),
    ];
    expect(paths(await sequencer().sort(files))).toEqual([
      "src/reactCompilerCoverage.test.ts",
      "src/b.test.tsx",
      "src/c.test.tsx",
      "src/a.test.ts",
    ]);
    // A shard without the sweep keeps Vitest's order.
    expect(paths(await sequencer().sort(files.filter((_, i) => i !== 2)))).toEqual([
      "src/b.test.tsx",
      "src/c.test.tsx",
      "src/a.test.ts",
    ]);
  });

  it("leaves Vitest's shards as they are", async () => {
    const files = Array.from({ length: 9 }, (_, i) => spec("unit", `src/f${i}.test.ts`));
    files.push(spec("unit", "src/reactCompilerCoverage.test.ts"));
    for (const index of [1, 2])
      expect(paths(await sequencer(2, index).shard(files))).toEqual(
        paths(await new BaseSequencer(context(2, index)).shard(files)),
      );
  });
});
