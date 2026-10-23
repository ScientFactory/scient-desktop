import { expect, it } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ConversationImportCommit } from "./ConversationImportCommit.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
} from "./conversationImportPlan.ts";
import { destination, importFixture } from "./conversationImport.test-fixtures.ts";
import { createProjects, importTestLayer } from "./conversationImport.test-harness.ts";
import { nativeImportTestLayer } from "./conversationImport.native-test-harness.ts";

it.for(["portable", "native"] as const)(
  "counts 100,000 %s import warnings in under 1,000ms",
  async (mode, { bench }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-28T09:30:00.000Z"));
        yield* createProjects;
        const context = yield* Effect.context<
          ConversationImportCommit | ProjectionStoreV2 | Crypto.Crypto
        >();
        const run = Effect.runPromiseWith(context);
        const fixture = importFixture({ turns: 1 });
        const warnings = Array.from({ length: 100_000 }, (_, index) => ({
          _tag: "export-warning" as const,
          warning: {
            code: "resource-unresolved" as const,
            message: `The linked image figure-${index + 1}.png was unavailable.`,
          },
        }));
        const input = { ...fixture.input, warnings };
        const results: Array<ReadonlyArray<string> | undefined> = [];
        const measured = yield* Effect.promise((signal) =>
          bench("mint ids and build import notices", { async: true }, async () => {
            results.push(
              await run(
                Effect.gen(function* () {
                  const ids = yield* mintConversationImportIds(input);
                  const command = buildConversationImportCommand({
                    validated: input,
                    ids,
                    destination: destination(),
                    importedAt: "2026-09-28T10:00:00.000Z",
                  });
                  if (mode === "native") {
                    // The original native budget includes the real commit and projection read.
                    yield* (yield* ConversationImportCommit).dispatch(command);
                    const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(
                      command.threadId,
                    );
                    expect(projection.thread.historyOrigin).toBe("conversation_import");
                    expect(projection.runs).toEqual([]);
                    expect(projection.runtimeRequests).toEqual([]);
                    expect(projection.providerSessions).toEqual([]);
                    expect(
                      projection.nodes.every((node) => !node.countsForRun && node.runId === null),
                    ).toBe(true);
                  }
                  return command.origin.notices;
                }),
                { signal },
              ),
            );
          }).run({ time: 0, iterations: 1, warmup: false }),
        );
        expect(results).toEqual([["100000 linked files or images were not included."]]);
        expect(measured.latency.mean).toBeLessThan(1_000);
      }).pipe(
        Effect.provide(mode === "native" ? nativeImportTestLayer() : importTestLayer()),
        Effect.scoped,
        Effect.provide(TestClock.layer()),
      ),
    );
  },
);
