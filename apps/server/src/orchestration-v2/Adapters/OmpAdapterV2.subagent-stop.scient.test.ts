import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { nativeOmpOrchestration } from "../../provider/testUtils/nativeOmpOrchestration.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { scientAgentTarget } from "../../provider/scient/ScientAgentTarget.ts";
import * as ServerConfig from "../../config.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  allocatorLayer,
  McpProviderSessions.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-child-stop-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const lifecycle = (id: string, status: string) => ({
  type: "subagent_lifecycle",
  payload: { id, status, agent: "task", detached: true, description: `Review ${id}` },
});

it.live.each([scientAgentTarget, ompTarget])(
  "$name Stop cancels only the selected native child and leaves its parent usable",
  (target) =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = scriptedOmpRpc({
          models: [{ provider: "test", id: "selected" }],
          initial: { provider: "test", id: "selected" },
          responseData: (frame) =>
            frame.type === "cancel_subagent" ? { cancelled: true } : undefined,
          beforeReply: (frame) =>
            frame.type === "cancel_subagent" ? [lifecycle(frame.subagentId!, "aborted")] : [],
        });
        const f = yield* nativeOmpOrchestration({ target, makeProcess: peer.makeProcess });
        yield* f.run(({ send, waitFor, completed, orchestrator }) =>
          Effect.gen(function* () {
            yield* send("Run two independent reviews");
            yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
            yield* peer.emit([
              { type: "agent_start" },
              lifecycle("first", "started"),
              lifecycle("second", "started"),
            ]);
            const before = yield* waitFor((p) => p.subagents.length === 2);
            const task = before.subagents.find((s) => s.nativeTaskRef?.nativeId === "first")!;
            const sibling = before.subagents.find((s) => s.nativeTaskRef?.nativeId === "second")!;
            const providerThread = before.providerThreads[0]!;
            const sessions = yield* ProviderSessionManagerV2;
            const live = yield* sessions.get(providerThread.providerSessionId!);
            assert.isTrue(Option.isSome(live));
            if (Option.isNone(live) || !live.value.stopSubagent)
              return yield* Effect.die("Missing native child Stop");
            const stop = live.value.stopSubagent;
            for (const foreign of [
              { ...providerThread, providerInstanceId: ProviderInstanceId.make("other-instance") },
              { ...providerThread, appThreadId: ThreadId.make("other-thread") },
              { ...providerThread, providerSessionId: ProviderSessionId.make("other-session") },
              {
                ...providerThread,
                nativeThreadRef: { ...providerThread.nativeThreadRef!, strength: "weak" as const },
              },
            ]) {
              assert.equal(
                (yield* Effect.result(stop({ providerThread: foreign, nativeTaskId: "first" })))
                  ._tag,
                "Failure",
              );
            }
            yield* stop({ providerThread, nativeTaskId: "unknown" });
            yield* stop({
              providerThread,
              nativeTaskId: "first",
              requestedAt: DateTime.makeUnsafe(0),
            });
            assert.isFalse(peer.state.frames.some((frame) => frame.type === "cancel_subagent"));
            const commandId = CommandId.make("stop-selected-native-child");
            yield* orchestrator.dispatch({
              type: "subagent.stop",
              commandId,
              threadId: f.threadId,
              runId: task.runId!,
              subagentId: task.id,
            });
            yield* completed(commandId);
            const stopped = yield* waitFor((p) =>
              p.subagents.some((s) => s.id === task.id && s.status === "cancelled"),
            );
            assert.equal(stopped.nodes.find((n) => n.id === task.id)?.status, "cancelled");
            assert.equal(stopped.turnItems.find((i) => i.nodeId === task.id)?.status, "cancelled");
            assert.deepEqual(
              stopped.subagents.find((s) => s.id === sibling.id),
              sibling,
            );
            assert.deepEqual(stopped.runs, before.runs);
            assert.deepEqual(stopped.providerTurns, before.providerTurns);
            assert.equal(peer.state.shutdowns, 0);
            assert.deepEqual(
              peer.state.frames
                .filter((frame) => frame.type === "cancel_subagent")
                .map((frame) => frame.subagentId),
              ["first"],
            );
            assert.isFalse(
              peer.state.frames.some(
                (frame) => frame.type === "abort" || frame.type === "abort_and_restore_queue",
              ),
            );
            yield* stop({ providerThread, nativeTaskId: "first" });
            assert.lengthOf(
              peer.state.frames.filter((frame) => frame.type === "cancel_subagent"),
              1,
            );
            yield* peer.emit([lifecycle("second", "completed")]);
            yield* peer.finish();
            yield* waitFor((p) => p.runs.some((r) => r.status === "completed"));
            yield* send("Continue the parent conversation");
            yield* waitFor(
              (p) => p.providerTurns.filter((t) => t.nativeAcceptance === "accepted").length === 2,
            );
            assert.lengthOf(peer.state.prompts, 2);
            assert.equal(peer.state.shutdowns, 0);
            yield* peer.finish();
            yield* waitFor((p) => p.runs.filter((r) => r.status === "completed").length === 2);
          }),
        );
      }),
    ).pipe(Effect.provide(dependencies)),
);

it.live.each(["already finished", "unsupported", "malformed"] as const)(
  "native child Stop handles %s without changing the parent or inventing a child outcome",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = scriptedOmpRpc({
          models: [{ provider: "test", id: "selected" }],
          initial: { provider: "test", id: "selected" },
          responseData: (frame) =>
            frame.type === "cancel_subagent" && outcome !== "unsupported"
              ? outcome === "already finished"
                ? { cancelled: false }
                : {}
              : undefined,
          commandError: (frame) =>
            frame.type === "cancel_subagent" && outcome === "unsupported"
              ? "Unknown command: cancel_subagent"
              : undefined,
        });
        const f = yield* nativeOmpOrchestration({
          target: scientAgentTarget,
          makeProcess: peer.makeProcess,
        });
        yield* f.run(({ send, waitFor }) =>
          Effect.gen(function* () {
            yield* send("Review a task");
            yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
            yield* peer.emit([{ type: "agent_start" }, lifecycle("child", "started")]);
            const before = yield* waitFor((p) => p.subagents.length === 1);
            const providerThread = before.providerThreads[0]!;
            const sessions = yield* ProviderSessionManagerV2;
            const live = yield* sessions.get(providerThread.providerSessionId!);
            if (Option.isNone(live) || !live.value.stopSubagent)
              return yield* Effect.die("Missing native child Stop");
            const result = yield* Effect.result(
              live.value.stopSubagent({ providerThread, nativeTaskId: "child" }),
            );
            assert.equal(result._tag, outcome === "already finished" ? "Success" : "Failure");
            if (result._tag === "Failure")
              assert.include(
                result.failure.message,
                outcome === "unsupported" ? "does not support" : "invalid subagent cancellation",
              );
            const unchanged = yield* waitFor(
              (p) =>
                outcome === "already finished" ||
                p.turnItems.some(
                  (item) =>
                    item.type === "system_notice" &&
                    item.message.includes(
                      outcome === "unsupported"
                        ? "does not support"
                        : "invalid subagent cancellation",
                    ),
                ),
            );
            assert.deepEqual(unchanged.subagents, before.subagents);
            assert.deepEqual(unchanged.runs, before.runs);
            assert.deepEqual(unchanged.providerTurns, before.providerTurns);
            assert.equal(peer.state.shutdowns, 0);
            assert.isFalse(
              peer.state.frames.some(
                (frame) => frame.type === "abort" || frame.type === "abort_and_restore_queue",
              ),
            );
            yield* peer.emit([lifecycle("child", "completed")]);
            yield* peer.finish();
            yield* waitFor((p) => p.runs.some((r) => r.status === "completed"));
          }),
        );
      }),
    ).pipe(Effect.provide(dependencies)),
);
