// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { cleanupRetiredThreadFilesystem } from "./RetiredThreadAttachmentCleanup.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("RetiredThreadAttachmentCleanup", (it) => {
  it.effect("deletes exact retired-thread files and clears the retry tombstone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO retired_projectless_thread_cleanup (thread_id)
        VALUES ('thread-retired')
      `;

      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-retired-files-"));
      const attachmentsDir = NodePath.join(stateDir, "attachments");
      const terminalLogsDir = NodePath.join(stateDir, "logs", "terminals");
      const providerLogsDir = NodePath.join(stateDir, "logs", "provider");
      const queueDir = NodePath.join(stateDir, "scient", "thread-queue");
      for (const directory of [attachmentsDir, terminalLogsDir, providerLogsDir, queueDir]) {
        NodeFS.mkdirSync(directory, { recursive: true });
      }
      try {
        const retiredId = createAttachmentId("thread-retired");
        const survivorId = createAttachmentId("thread-retired-extra");
        assert.isNotNull(retiredId);
        assert.isNotNull(survivorId);
        const retiredPath = NodePath.join(attachmentsDir, `${retiredId}.png`);
        const survivorPath = NodePath.join(attachmentsDir, `${survivorId}.png`);
        NodeFS.writeFileSync(retiredPath, "remove");
        NodeFS.writeFileSync(survivorPath, "keep");
        const terminalPath = NodePath.join(
          terminalLogsDir,
          `terminal_${Encoding.encodeBase64Url("thread-retired")}.log`,
        );
        const providerPath = NodePath.join(providerLogsDir, "events.thread-retired.log.1");
        const queuePath = NodePath.join(
          queueDir,
          `${NodeCrypto.createHash("sha256").update("thread-retired").digest("hex")}.json`,
        );
        NodeFS.writeFileSync(terminalPath, "remove");
        NodeFS.writeFileSync(providerPath, "remove");
        NodeFS.writeFileSync(queuePath, "remove");

        yield* cleanupRetiredThreadFilesystem({
          stateDir,
          attachmentsDir,
          terminalLogsDir,
          providerLogsDir,
        });

        assert.isFalse(NodeFS.existsSync(retiredPath));
        assert.isTrue(NodeFS.existsSync(survivorPath));
        assert.isFalse(NodeFS.existsSync(terminalPath));
        assert.isFalse(NodeFS.existsSync(providerPath));
        assert.isFalse(NodeFS.existsSync(queuePath));
        const cleanup = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM retired_projectless_thread_cleanup
        `;
        assert.equal(cleanup[0]?.count, 0);
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps the tombstone when a sanitized file segment belongs to an active thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, workspace_root, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at
        ) VALUES (
          'thread-foo', 'project-active', NULL, 'Active thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO retired_projectless_thread_cleanup (thread_id)
        VALUES ('thread.foo')
      `;

      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-retired-files-"));
      const attachmentsDir = NodePath.join(stateDir, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      try {
        const sharedSegmentAttachment = createAttachmentId("thread-foo");
        assert.isNotNull(sharedSegmentAttachment);
        const attachmentPath = NodePath.join(attachmentsDir, `${sharedSegmentAttachment}.png`);
        NodeFS.writeFileSync(attachmentPath, "keep");

        yield* cleanupRetiredThreadFilesystem({
          stateDir,
          attachmentsDir,
          terminalLogsDir: NodePath.join(stateDir, "logs", "terminals"),
          providerLogsDir: NodePath.join(stateDir, "logs", "provider"),
        });

        assert.isTrue(NodeFS.existsSync(attachmentPath));
        const cleanup = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM retired_projectless_thread_cleanup
        `;
        assert.equal(cleanup[0]?.count, 1);
      } finally {
        NodeFS.rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );
});
