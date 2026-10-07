// @effect-diagnostics nodeBuiltinImport:off
/**
 * Opt-in, synthetic large-import measurements. Run with SCIENT_IMPORT_BENCH=1;
 * this intentionally does not add a multi-thousand-message cost to normal tests.
 * SCIENT_IMPORT_BENCH_RECORDS sets the records of the work-log-heavy import.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import type { ConversationImportId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
          const thread = yield* Effect.flatMap(ProjectionStoreV2, (store) =>
            store.getThreadProjection(completion.result.threadId),
          );
          assert.strictEqual(completion.result.messageCount, 3_000);
          assert.strictEqual(thread.thread.id, completion.result.threadId);
          assert.strictEqual(thread.messages.length, 3_000);
          assert.deepStrictEqual(thread.runs, []);
          assert.deepStrictEqual(thread.runtimeRequests, []);
          process.stdout.write(
            `SCIENT_IMPORT_BENCH messages=${completion.result.messageCount} turns=1500 importMs=${Math.round(elapsedMs)} rssBeforeBytes=${before.rss} rssAfterBytes=${after.rss} heapBeforeBytes=${before.heapUsed} heapAfterBytes=${after.heapUsed} processMaxRssRaw=${process.resourceUsage().maxRSS}\n`,
          );
        }),
      ),
      Effect.provide(importTestLayer()),
    ),
  180_000,
);

const heavyRecords = Number(
  process.env.SCIENT_IMPORT_BENCH_RECORDS ?? CONVERSATION_IMPORT_MAX_RECORDS,
);

it.effect.skipIf(process.env.SCIENT_IMPORT_BENCH !== "1")(
  "measures a work-log-heavy import at the record limit on an on-disk database",
  () =>
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
          const started = performance.now();
          const completion = yield* Effect.flatMap(ConversationImporter, (importer) =>
            importer.importConversation(lease, {
              destination: destination(),
              principal: principal(),
            }),
          );
          const elapsedMs = performance.now() - started;
          const after = process.memoryUsage();
          assert.strictEqual(completion.result.messageCount, 2 * turns);
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
    ),
  600_000,
);

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

it.effect.skipIf(process.env.SCIENT_IMPORT_BENCH !== "1")(
  "measures validating a .scic whose snapshot is close to the snapshot size limit",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-scic-bench-"));
      const { files, snapshotBytes } = maxSnapshotPackageFiles();
      assert.isBelow(snapshotBytes, SCIC_MAX_SNAPSHOT_BYTES);
      const bytes = yield* Effect.promise(() => zipBytesPromise(files));
      const packagePath = NodePath.join(directory, "package.scic");
      NodeFS.writeFileSync(packagePath, bytes);
      NodeFS.mkdirSync(NodePath.join(directory, "attachments"));
      const before = process.memoryUsage();
      const maxRssBefore = process.resourceUsage().maxRSS;
      const started = performance.now();
      const validated = yield* readScicPackage({
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
      const elapsedMs = performance.now() - started;
      const maxRssAfter = process.resourceUsage().maxRSS;
      assert.strictEqual(validated.snapshot.messages.length, 4_000);
      process.stdout.write(
        `SCIENT_IMPORT_BENCH maxSnapshot snapshotBytes=${snapshotBytes} packageBytes=${bytes.byteLength} validateMs=${Math.round(elapsedMs)} rssBeforeBytes=${before.rss} processMaxRssRawBefore=${maxRssBefore} processMaxRssRawAfter=${maxRssAfter} heapBeforeBytes=${before.heapUsed} heapAfterBytes=${process.memoryUsage().heapUsed}\n`,
      );
    }),
  600_000,
);
