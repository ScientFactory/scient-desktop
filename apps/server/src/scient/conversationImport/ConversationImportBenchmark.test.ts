// @effect-diagnostics nodeBuiltinImport:off
/**
 * Opt-in, synthetic large-import measurement. Run with SCIENT_IMPORT_BENCH=1;
 * this intentionally does not add a multi-thousand-message cost to normal tests.
 */
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ConversationImporter } from "./ConversationImporter.ts";
import {
  IMPORT_ID,
  destination,
  importFixture,
  principal,
  testLease,
} from "./conversationImport.test-fixtures.ts";
import { createProjects, importTestLayer } from "./conversationImport.test-harness.ts";

it.effect.skipIf(process.env.SCIENT_IMPORT_BENCH !== "1")(
  "measures one 3,000-message conversation import through the real orchestration engine",
  () =>
    createProjects.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const fixture = importFixture({ turns: 1_500 });
          const { lease } = testLease({
            fixture,
            attemptDirectory: NodePath.join(
              config.stateDir,
              "conversation-imports",
              IMPORT_ID,
              "bench",
            ),
          });
          const before = process.memoryUsage();
          const started = performance.now();
          const completion = yield* Effect.flatMap(ConversationImporter, (importer) =>
            importer.importConversation(lease, {
              destination: destination(),
              principal: principal(),
            }),
          );
          const elapsedMs = performance.now() - started;
          const after = process.memoryUsage();
          const thread = yield* Effect.flatMap(ProjectionSnapshotQuery, (query) =>
            query.getThreadDetailById(completion.result.threadId, { fullHistory: true }),
          );
          assert.strictEqual(completion.result.messageCount, 3_000);
          assert.isTrue(thread._tag === "Some");
          if (thread._tag === "Some") assert.strictEqual(thread.value.messages.length, 3_000);
          process.stdout.write(
            `SCIENT_IMPORT_BENCH messages=${completion.result.messageCount} turns=1500 importMs=${Math.round(elapsedMs)} rssBeforeBytes=${before.rss} rssAfterBytes=${after.rss} heapBeforeBytes=${before.heapUsed} heapAfterBytes=${after.heapUsed} processMaxRssRaw=${process.resourceUsage().maxRSS}\n`,
          );
        }),
      ),
      Effect.provide(importTestLayer()),
    ),
  180_000,
);
