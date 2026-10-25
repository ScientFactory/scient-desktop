// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * How long one sync takes, stage by stage: 1, 10, 50 and 300 files coming
 * from Overleaf, and 1, 10 and 50 going to it, against a real local bare
 * repository with the real applier. The 300 case puts every file in one folder,
 * past the 256 folders one native lease can bind. Run it in the explicit
 * benchmark lane from `apps/server`:
 *
 *   pnpm exec vp test bench --run --fileParallelism=false --maxWorkers=1 src/scient/overleaf/OverleafSync.bench.ts
 *
 * It prints one table. The numbers are wall-clock times on this machine; only
 * their comparison before and after a change means anything.
 */
import { afterAll, describe, expect, it, type TestContext } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import { measureEffectBenchmark } from "../../testUtils/benchmark.testkit.ts";
import { canApply, run, world, write } from "./OverleafCoordinator.testkit.ts";

/** Spans worth a column: the sync's stages and the work inside them. */
const STAGES = [
  ["prepare", "OverleafCoordinator.prepare"],
  ["confirm", "OverleafCoordinator.confirm"],
  ["fetch", "OverleafRepository.fetch"],
  ["head", "OverleafRepository.remoteHead"],
  ["build", "OverleafCoordinator.buildReview"],
  ["apply", "OverleafCoordinator.runLinked"],
  ["writes", "WorkspaceFileSystem.replaceFileRetained"],
  ["adopt", "OverleafCoordinator.adoption"],
  ["send", "OverleafCoordinator.publish"],
] as const;

/** Total milliseconds and count per span name, for everything run under it. */
const timing = () => {
  const totals = new Map<string, { ms: number; count: number }>();
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const total = totals.get(options.name) ?? { ms: 0, count: 0 };
        total.ms += Number(endTime - options.startTime) / 1e6;
        total.count += 1;
        totals.set(options.name, total);
      };
      return span;
    },
  });
  return { tracer, totals };
};

const rows: string[] = [];
const seconds = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(2);

const files = (count: number, prefix: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}/file-${String(index).padStart(3, "0")}.tex`,
      `\\section{${prefix} ${index}}\n${"Some manuscript text. ".repeat(200)}\n`,
    ]),
  );

const measure = (direction: "incoming" | "outgoing", count: number, bench: TestContext["bench"]) =>
  run(
    Effect.gen(function* () {
      const synced = { "main.tex": "\\documentclass{article}\n" };
      const w = yield* world({
        overleaf: "git",
        synced,
        remote: direction === "incoming" ? { ...synced, ...files(count, "from-overleaf") } : synced,
      });
      if (direction === "outgoing") yield* write(w.folder, files(count, "from-here"));
      const { tracer, totals } = timing();
      const [result] = yield* measureEffectBenchmark(
        bench,
        `${direction} ${count}`,
        w.sync().pipe(Effect.withSpan("OverleafSyncBench.sync"), Effect.withTracer(tracer)),
      );
      const total = totals.get("OverleafSyncBench.sync")?.ms;
      expect(result).toMatchObject({
        _tag: "applied",
        adopted: { outcome: "complete" },
        publication: { _tag: direction === "incoming" ? "none" : "accepted" },
      });
      const git = totals.get("OverleafGitExecutor.execute");
      rows.push(
        [
          `${direction} ${String(count).padStart(2)}`,
          seconds(total),
          ...STAGES.map(([, name]) => {
            const span = totals.get(name);
            return span === undefined
              ? "-"
              : `${seconds(span.ms)}${span.count > 1 ? `x${span.count}` : ""}`;
          }),
          String(git?.count ?? 0),
        ].join(" | "),
      );
    }),
  );

describe.skipIf(!canApply)("Overleaf sync timing", () => {
  for (const direction of ["incoming", "outgoing"] as const)
    for (const count of direction === "incoming" ? [1, 10, 50, 300] : [1, 10, 50])
      it(`${direction} ${count}`, ({ bench }) =>
        Effect.runPromise(measure(direction, count, bench)));

  afterAll(() => {
    const header = ["sync", "total s", ...STAGES.map(([label]) => label), "git runs"];
    process.stdout.write(
      `\n${[header.join(" | "), header.map(() => "---").join(" | "), ...rows].join("\n")}\n\n`,
    );
  });
});
