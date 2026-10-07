// @effect-diagnostics nodeBuiltinImport:off -- Synthetic legacy queue fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ComposerContextId, ThreadId, type OrchestrationMessageContext } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { readQueue } from "./Ledger.ts";
import { importLegacyQueue } from "./migration.ts";
import { legacyQueueFilePath } from "./Store.ts";

it.effect(
  "imports waiting payloads once without reviving old send, steer, or edit authority",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-queue-cutover-"));
    const threadId = ThreadId.make("queue-cutover");
    const context: OrchestrationMessageContext = {
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("analysis"),
          kind: "skill",
          label: "Analysis",
          name: "analysis",
        },
      ],
    };
    const item = {
      queueItemId: "qitem_old",
      text: "Analyze the retained data",
      attachments: [],
      composerSnapshot: '{"draft":"retained"}',
      selectedScientSkillNames: ["analysis"],
      context,
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      state: "editing",
      editToken: "stale-editor",
      steerRequested: true,
      sendRequested: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const filename = legacyQueueFilePath(directory, threadId);
    NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
    const bytes = JSON.stringify({
      formatVersion: 1,
      threadId,
      items: [item, { ...item, queueItemId: "qitem_second", text: "Second queued message" }],
    });
    NodeFS.writeFileSync(filename, bytes);
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const document = yield* importLegacyQueue(threadId, yield* readQueue(threadId));
        assert.equal(document.awaitingCompletion, true);
        assert.deepEqual(
          document.items.map((entry) => entry.queueItemId),
          ["qitem_old", "qitem_second"],
        );
        const first = document.items[0];
        assert.equal(first?.state, "waiting");
        assert.equal(first?.editToken, undefined);
        assert.equal(first?.steerRequested, false);
        assert.equal(first?.sendRequested, false);
        assert.equal(first?.text, item.text);
        assert.deepEqual(first?.selectedScientSkillNames, item.selectedScientSkillNames);
        assert.deepEqual(first?.context, context);
        assert.equal(first?.composerSnapshot, item.composerSnapshot);
        assert.deepEqual(first?.modelSelection, item.modelSelection);
        assert.equal(first?.runtimeMode, item.runtimeMode);
        assert.equal(first?.interactionMode, item.interactionMode);
        assert.deepEqual(yield* importLegacyQueue(threadId, document), document);
        const persisted = yield* readQueue(threadId);
        assert.equal(NodeFS.readFileSync(filename, "utf8"), bytes);
        NodeFS.writeFileSync(filename, "changed after successful migration; must not be read");
        assert.deepEqual(yield* importLegacyQueue(threadId, yield* readQueue(threadId)), persisted);
      }).pipe(Effect.provide(ServerConfig.layer({ ...config, stateDir: directory })));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqlitePersistenceMemory, ServerConfig.layerTest(directory, directory)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);
