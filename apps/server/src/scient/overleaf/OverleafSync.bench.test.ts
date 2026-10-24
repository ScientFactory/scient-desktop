// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * How long one sync takes, stage by stage: 1, 10 and 50 files coming from
 * Overleaf, and 1, 10 and 50 going to it, against a real local bare repository
 * with the real applier. Skipped unless asked for; run it from `apps/server`:
 *
 *   SCIENT_OVERLEAF_BENCH=1 node_modules/.bin/vp test run src/scient/overleaf/OverleafSync.bench.test.ts --testTimeout=0
 *
 * It prints one table. The numbers are wall-clock times on this machine; only
 * their comparison before and after a change means anything.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

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

const measure = (direction: "incoming" | "outgoing", count: number) =>
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
      const result = yield* w
        .sync()
        .pipe(Effect.withSpan("OverleafSyncBench.sync"), Effect.withTracer(tracer));
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

describe.skipIf(!canApply || process.env.SCIENT_OVERLEAF_BENCH !== "1")(
  "Overleaf sync timing",
  () => {
    it.live.each(
      (["incoming", "outgoing"] as const).flatMap((direction) =>
        [1, 10, 50].map((count) => ({ direction, count })),
      ),
    )("$direction $count", ({ direction, count }) => measure(direction, count));

    it("prints the table", () => {
      const header = ["sync", "total s", ...STAGES.map(([label]) => label), "git runs"];
      // Straight to the terminal: the runner keeps console output of passing tests to itself.
      process.stdout.write(
        `\n${[header.join(" | "), header.map(() => "---").join(" | "), ...rows].join("\n")}\n\n`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  },
);
