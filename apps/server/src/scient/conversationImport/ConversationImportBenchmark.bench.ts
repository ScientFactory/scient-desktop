// @effect-diagnostics nodeBuiltinImport:off
/**
 * Synthetic large-import measurements in the explicit Vitest benchmark lane,
 * not the normal test suite.
 * SCIENT_IMPORT_BENCH_RECORDS sets the records of the work-log-heavy import.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";
import type { ConversationImportId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import {
  decodeSnapshot,
  encodeSnapshot,
  makePackage,
  zipBytesPromise,
} from "../conversationFile/scic.test-fixtures.ts";
import { readScicPackage } from "../conversationFile/ScicReader.ts";
import { sha256Digest } from "../conversationFile/ScicWriter.ts";
import {
  SCIC_MANIFEST_ENTRY,
  SCIC_MAX_SNAPSHOT_BYTES,
  SCIC_SNAPSHOT_ENTRY,
  type ScicManifest,
} from "../conversationFile/scicFormat.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import {
  CONVERSATION_IMPORT_MAX_RECORDS,
  ConversationImporter,
  conversationContentDigest,
  conversationImportRecordCount,
} from "./ConversationImporter.ts";
import {
  IMPORT_ID,
  destination,
  importFixture,
  principal,
  testLease,
} from "./conversationImport.test-fixtures.ts";
import {
  createNativeProjects as createProjects,
  nativeImportTestLayer as importTestLayer,
} from "./conversationImport.native-test-harness.ts";

const singleSample = { time: 0, iterations: 1, warmup: false } as const;

it("measures one 3,000-message conversation import through the real orchestration engine", async ({
  bench,
}) =>
  Effect.runPromise(
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
          const operation = Effect.flatMap(ConversationImporter, (importer) =>
            importer.importConversation(lease, {
              destination: destination(),
              principal: principal(),
            }),
          );
          const run = Effect.runPromiseWith(yield* Effect.context<ConversationImporter>());
          const completions: Array<Effect.Success<typeof operation>> = [];
          const measured = yield* Effect.promise((signal) =>
            bench("import 3,000 messages", { async: true }, async () => {
              completions.push(await run(operation, { signal }));
            }).run(singleSample),
          );
          expect(completions).toHaveLength(1);
          const completion = completions[0]!;
          const elapsedMs = measured.latency.mean;
          const after = process.memoryUsage();
          const thread = yield* Effect.flatMap(ProjectionStoreV2, (store) =>
            store.getThreadProjection(completion.result.threadId),
          );
          expect(completion.result.messageCount).toBe(3_000);
          expect(thread.thread.id).toBe(completion.result.threadId);
          expect(thread.messages).toHaveLength(3_000);
          expect(thread.runs).toEqual([]);
          expect(thread.runtimeRequests).toEqual([]);
          process.stdout.write(
            `SCIENT_IMPORT_BENCH messages=${completion.result.messageCount} turns=1500 importMs=${Math.round(elapsedMs)} rssBeforeBytes=${before.rss} rssAfterBytes=${after.rss} heapBeforeBytes=${before.heapUsed} heapAfterBytes=${after.heapUsed} processMaxRssRaw=${process.resourceUsage().maxRSS}\n`,
          );
        }),
      ),
      Effect.provide(importTestLayer()),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    ),
  ));

const heavyRecords = Number(
  process.env.SCIENT_IMPORT_BENCH_RECORDS ?? CONVERSATION_IMPORT_MAX_RECORDS,
);

it("measures a work-log-heavy import at the record limit on an on-disk database", async ({
  bench,
}) =>
  Effect.runPromise(
    createProjects.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          // Two messages and eight tool entries with 8,000 characters of output per turn.
          const perTurn = 8;
          const turns = Math.floor((heavyRecords - 1) / (2 + perTurn));
          const fixture = importFixture({
            turns,
            workLog: true,
            workLogPerTurn: perTurn,
            workLogOutputChars: 8_000,
          });
          const records = conversationImportRecordCount(fixture.input.snapshot);
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
          const operation = Effect.flatMap(ConversationImporter, (importer) =>
            importer.importConversation(lease, {
              destination: destination(),
              principal: principal(),
            }),
          );
          const run = Effect.runPromiseWith(yield* Effect.context<ConversationImporter>());
          const completions: Array<Effect.Success<typeof operation>> = [];
          const measured = yield* Effect.promise((signal) =>
            bench("import work-log-heavy record limit", { async: true }, async () => {
              completions.push(await run(operation, { signal }));
            }).run(singleSample),
          );
          expect(completions).toHaveLength(1);
          const completion = completions[0]!;
          const elapsedMs = measured.latency.mean;
          const after = process.memoryUsage();
          expect(completion.result.messageCount).toBe(2 * turns);
          const databaseBytes = ["", "-wal"].reduce(
            (total, suffix) =>
              total +
              (NodeFS.statSync(`${config.dbPath}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
            0,
          );
          process.stdout.write(
            `SCIENT_IMPORT_BENCH workLogHeavy records=${records} turns=${turns} importMs=${Math.round(elapsedMs)} rssBeforeBytes=${before.rss} rssAfterBytes=${after.rss} heapBeforeBytes=${before.heapUsed} heapAfterBytes=${after.heapUsed} databaseBytes=${databaseBytes} processMaxRssRaw=${process.resourceUsage().maxRSS}\n`,
          );
        }),
      ),
      Effect.provide(importTestLayer({ persistence: "file" })),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    ),
  ));

/** A valid package whose snapshot is 4,000 messages of 32,000 characters: about 122 MiB. */
function maxSnapshotPackageFiles() {
  const pkg = makePackage();
  const second = pkg.snapshot.messages[1];
  const unsealed = decodeSnapshot({
    ...encodeSnapshot(pkg.snapshot),
    messages: [
      encodeSnapshot(pkg.snapshot).messages[0],
      ...Array.from({ length: 3_999 }, (_, index) => ({
        ...encodeSnapshot(pkg.snapshot).messages[1],
        n: index + 2,
        id: index === 0 ? second!.id : `message-${index + 2}`,
        role: index % 2 === 0 ? "assistant" : "user",
        turnId: index % 2 === 0 ? `turn-${index + 2}` : null,
        text: `Message ${index + 2} `.padEnd(32_000, "lorem ipsum dolor sit amet "),
      })),
    ],
  });
  const snapshot = { ...unsealed, contentDigest: conversationContentDigest(unsealed) };
  const snapshotBytes = new TextEncoder().encode(JSON.stringify(encodeSnapshot(snapshot)));
  const files = pkg.files.map((file) => {
    if (file.path === SCIC_SNAPSHOT_ENTRY) return { ...file, bytes: snapshotBytes };
    if (file.path !== SCIC_MANIFEST_ENTRY) return file;
    const manifest = JSON.parse(new TextDecoder().decode(file.bytes)) as ScicManifest;
    const entries = manifest.entries.map((entry) =>
      entry.path === SCIC_SNAPSHOT_ENTRY
        ? { ...entry, byteLength: snapshotBytes.byteLength, sha256: sha256Digest(snapshotBytes) }
        : entry,
    );
    return {
      ...file,
      bytes: new TextEncoder().encode(
        JSON.stringify({ ...manifest, contentDigest: snapshot.contentDigest, entries }),
      ),
    };
  });
  return { files, snapshotBytes: snapshotBytes.byteLength };
}

it("measures validating a .scic whose snapshot is close to the snapshot size limit", async ({
  bench,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-scic-bench-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const { files, snapshotBytes } = maxSnapshotPackageFiles();
      expect(snapshotBytes).toBeLessThan(SCIC_MAX_SNAPSHOT_BYTES);
      const bytes = yield* Effect.promise(() => zipBytesPromise(files));
      const packagePath = NodePath.join(directory, "package.scic");
      NodeFS.writeFileSync(packagePath, bytes);
      NodeFS.mkdirSync(NodePath.join(directory, "attachments"));
      const before = process.memoryUsage();
      const maxRssBefore = process.resourceUsage().maxRSS;
      const operation = readScicPackage({
        importId: IMPORT_ID as ConversationImportId,
        packagePath,
        packageSha256: sha256Digest(bytes),
        packageBytes: bytes.byteLength,
        attachmentsDirectory: NodePath.join(directory, "attachments"),
        snapshotPath: NodePath.join(directory, "conversation.json"),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
      const run = Effect.runPromiseWith(yield* Effect.context<Effect.Services<typeof operation>>());
      const validations: Array<Effect.Success<typeof operation>> = [];
      const measured = yield* Effect.promise((signal) =>
        bench("validate near-limit SCIC snapshot", { async: true }, async () => {
          validations.push(await run(operation, { signal }));
        }).run(singleSample),
      );
      expect(validations).toHaveLength(1);
      const validated = validations[0]!;
      const elapsedMs = measured.latency.mean;
      const maxRssAfter = process.resourceUsage().maxRSS;
      expect(validated.snapshot.messages).toHaveLength(4_000);
      process.stdout.write(
        `SCIENT_IMPORT_BENCH maxSnapshot snapshotBytes=${snapshotBytes} packageBytes=${bytes.byteLength} validateMs=${Math.round(elapsedMs)} rssBeforeBytes=${before.rss} processMaxRssRawBefore=${maxRssBefore} processMaxRssRawAfter=${maxRssAfter} heapBeforeBytes=${before.heapUsed} heapAfterBytes=${process.memoryUsage().heapUsed}\n`,
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));
