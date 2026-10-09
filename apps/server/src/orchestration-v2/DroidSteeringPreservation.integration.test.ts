/** Native causal preservation cases; no injected provider receipts or scheduling replacements. */
import { assert, it } from "@effect/vitest";
import * as NodeUtil from "node:util";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ChatAttachmentId,
  OrchestrationMessageContext,
  DroidSettings,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Command,
  OrchestrationV2RunJson,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2CheckpointJson,
  type RunId,
  type RunAttemptId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import type { AcpProtocolLogEvent } from "effect-acp/protocol";
import * as Config from "../config.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ScientTestProviderHost from "./testkit/ScientTestProviderHost.ts";
import { makeDroidAcpRuntime } from "../provider/acp/DroidAcpSupport.ts";
import { scriptedDroid } from "../provider/testUtils/scriptedDroid.ts";
import { AcpTransportError } from "effect-acp/errors";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import { makeDroidAdapterV2, type DroidAdapterV2Options } from "./Adapters/DroidAdapterV2.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { EventStoreV2 } from "./EventStore.ts";
import {
  ThreadCommandExecutor,
  layer as threadCommandExecutorLayer,
} from "./ThreadCommandExecutor.ts";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { layer as idAllocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
import { nativeSettlementTrace } from "./testkit/OmpNativeConjunctions.ts";

const decodeRunJson = Schema.decodeSync(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeCheckpointScopeJson = Schema.decodeSync(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJson),
);
const decodeCheckpointJson = Schema.decodeSync(
  Schema.fromJsonString(OrchestrationV2CheckpointJson),
);
const encodeNativeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeNativePrompt = Schema.decodeUnknownSync(
  Schema.Struct({
    prompt: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
);

const fixtureServices = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  Config.layerTest(process.cwd(), { prefix: "droid-steer-preservation-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const outer = ScientTestProviderHost.layer.pipe(Layer.provideMerge(fixtureServices));
const userText = (text: string) =>
  text.match(/<user_request>\n([\s\S]*)\n<\/user_request>$/u)?.[1] ?? text;
const decodePhase = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.String,
      cwd: Schema.String,
      model: Schema.String,
      autonomy: Schema.String,
    }),
  ),
);
const peerBody = `
const controls = process.env.DROID_STEER_CONTROLS;
const pending = [];
const variant = process.env.DROID_STEER_VARIANT;
const task = () => update({ sessionUpdate: "tool_call", toolCallId: "task", title: "Task", kind: "other", status: "pending",
  rawInput: { subagent_type: "explorer", description: "Review the host", prompt: "Review it.", await: variant === "foreground-task" } });
const taskResult = (id, text) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed",
  rawOutput: { text }, content: [{ type: "content", content: { type: "text", text } }] });
const report = (id, taskId, status) => {
  update({ sessionUpdate: "tool_call", toolCallId: id, title: "TaskOutput", kind: "other", status: "pending",
    rawInput: { task_id: taskId, block: true, timeout: 600000 } });
  taskResult(id, "Task ID: " + taskId + "\\nDescription: Review the host\\nStatus: " + status + "\\nDuration: 1s\\n\\nThe host is sound.");
};
const wire = (toolCallId, sessionUpdate, status) => JSON.stringify({ jsonrpc: "2.0", method: "session/update",
  params: { sessionId: "scripted", update: { sessionUpdate, toolCallId, title: "Run " + toolCallId, kind: "execute", status } } }) + "\\n";
const openSteps = new Map();
const steps = (...calls) => {
  for (const [id, , status] of calls) openSteps.set(id, status);
  process.stdout.write(calls.map(call => wire(...call)).join(""));
};
function onPrompt(message) {
  const full = message.params.prompt[0].text;
  const text = full.match(/<user_request>\\n([\\s\\S]*)\\n<\\/user_request>$/)?.[1] ?? full;
  fs.appendFileSync(controls + "/phases.ndjson", JSON.stringify({text, cwd: process.cwd(), model: state.model, autonomy: state.autonomy}) + "\\n");
  pending.push(message);
  if (text === "ordinary-restart" || text.endsWith("User message:\\nordinary-restart")) fs.writeFileSync("ordinary-restart.txt", JSON.stringify({cwd: process.cwd(), autonomy: state.autonomy}));
  if (text === "first") {
    if (variant === "foreground-task" || variant === "background") {
      task();
      if (variant === "background") taskResult("task", "Task launched in background.\\ntask_id: t-1\\nsession_id: t-1");
    } else steps(["run", "tool_call", "pending"], ["run", "tool_call_update", "in_progress"]);
  }
  if (text === "follow-up" && variant === "reannounce") steps(["run", "tool_call_update", "in_progress"]);
  update({ sessionUpdate: "agent_message_chunk", content: {type: "text", text: variant === "tail" && text === "first" ? "Keep the old answer." : "native prompt: " + text} });
}
onCancel = () => {
  steps(...Array.from(openSteps).filter(([,status]) => status === "pending" || status === "in_progress").map(([id]) => [id, "tool_call_update", "failed"]));
  for (const message of pending.splice(0)) reply(message, {stopReason: "cancelled"});
};
setInterval(() => {
  for (const name of ["handoff", "finish-run", "finish-next", "finish-prompt", "finish-first", "abort-first", "fail-prompt", "fail-first", "bg-running", "bg-unknown", "bg-other", "bg-completed"]) {
    const file = controls + "/" + name;
    if (!fs.existsSync(file)) continue;
    fs.unlinkSync(file);
    if (name === "handoff") steps(["run", "tool_call_update", "completed"], ["next", "tool_call", "in_progress"]);
    if (name === "finish-run") steps(["run", "tool_call_update", "completed"]);
    if (name === "finish-next") steps(["next", "tool_call_update", "completed"]);
    if (name === "finish-prompt") for (const message of pending.splice(0)) reply(message, {stopReason: "end_turn"});
    if (name === "fail-first") { const first = pending.shift(); if (first) fail(first, {code: -32603, message: "Internal error", data: "boom"}); }
    if (name === "fail-prompt") for (const message of pending.splice(0)) fail(message, {code: -32603, message: "Internal error", data: "boom"});
    if (name === "finish-first" || name === "abort-first") {
      const first = pending.shift();
      if (variant === "old-live") steps(["run", "tool_call_update", "in_progress"]);
      if (variant === "late") steps(["late", "tool_call", "pending"]);
      if (first) reply(first, {stopReason: name === "abort-first" ? "cancelled" : "end_turn"});
    }
    if (name === "bg-running") report("check", "t-1", "running");
    if (name === "bg-unknown") report("unknown", "t-other", "completed");
    if (name === "bg-other") process.stdout.write(JSON.stringify({jsonrpc:"2.0", method:"session/update", params:{sessionId:"another", update:{sessionUpdate:"tool_call_update",toolCallId:"task",status:"completed"}}}) + "\\n");
    if (name === "bg-completed") report("wait", "t-1", "completed");
  }
}, 5);
`;

type NativeHooks = {
  batchBegin?: Effect.Effect<void> | undefined;
  afterReserve?: Effect.Effect<void> | undefined;
  beforeConsume?: Effect.Effect<void> | undefined;
  promptReturn?: Effect.Effect<void> | undefined;
  cancel?: Effect.Effect<void> | undefined;
  afterCancel?: Effect.Effect<void> | undefined;
  failAfterCancel?: boolean;
  afterStart?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterTurnStartError>;
  ownerConfigured?: Effect.Effect<void>;
  terminalProbe?: (input: {
    attemptId: RunAttemptId;
    status: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["droidSteerTerminalHeld"]>>[1];
    held: boolean;
  }) => Effect.Effect<void>;
  lockRequested?: Effect.Effect<void>;
  lockAcquired?: Effect.Effect<void>;
};
const fixture = Effect.fnUntraced(function* (name: string, variant = "normal") {
  const fs = yield* FileSystem.FileSystem;
  // Optional synthetic receipts survive the test reporter suppressing successful stdout.
  const receiptDirectory = process.env.DROID_STEER_RECEIPTS;
  if (receiptDirectory !== undefined)
    yield* fs.makeDirectory(receiptDirectory, { recursive: true });
  const record = (phase: string, value: unknown) =>
    receiptDirectory === undefined
      ? Effect.void
      : fs
          .writeFileString(
            `${receiptDirectory}/${name}-${phase}.json`,
            JSON.stringify(value, null, 2) + "\n",
          )
          .pipe(Effect.orDie);
  const controls = yield* fs.makeTempDirectoryScoped({ prefix: "droid-steer-controls-" });
  const workspace = yield* checkpointWorkspace(`droid-steer-${name}`);
  const cwd = yield* fs.realPath(workspace);
  const peer = yield* scriptedDroid(peerBody, {
    DROID_STEER_CONTROLS: controls,
    DROID_STEER_VARIANT: variant,
  });
  const hooks: NativeHooks = {};
  const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pids: number[] = [];
  const exits: Array<Fiber.Fiber<unknown>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    nativeSpawner.spawn(command).pipe(
      Effect.tap((handle) =>
        Effect.gen(function* () {
          pids.push(Number(handle.pid));
          exits.push(yield* handle.exitCode.pipe(Effect.exit, Effect.forkDetach));
        }),
      ),
    ),
  );
  // Layer disposal precedes these witnesses and then the fixture directory finalizers.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const exitResults = yield* Effect.forEach(exits, (exit) =>
        Fiber.join(exit).pipe(Effect.timeout("5 seconds"), Effect.orDie),
      );
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/u);
      const cleanup = { name, pids, exitResults, gone: true };
      yield* record("cleanup", cleanup);
      yield* Effect.log("DROID_STEER_CLEANUP", encodeNativeJson(cleanup));
    }),
  );
  const protocol: AcpProtocolLogEvent[] = [];
  const decodedQueue = yield* Queue.unbounded<AcpProtocolLogEvent>();
  const instanceId = ProviderInstanceId.make(`droid-steer-${name}`);
  const threadId = ThreadId.make(`droid-steer:${name}`);
  const stoppedDelegatedTaskParents: Array<ThreadId> = [];
  const selection = { instanceId, model: "droid-native" };
  const otherSelection = {
    instanceId: ProviderInstanceId.make(`droid-steer-other-${name}`),
    model: "droid-other",
    options: [],
  };
  let policyCwd = cwd;
  const policyLayer = Layer.succeed(RuntimePolicyV2, {
    resolve: ({ thread }) =>
      Effect.sync(() => ({
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        cwd: policyCwd,
      })),
  });
  const config = yield* Config.ServerConfig;
  const adapterOptions = {
    testHooks: {
      afterDroidDecodedBatchBegin: () => hooks.batchBegin ?? Effect.void,
      afterDroidSteerReserved: () => hooks.afterReserve ?? Effect.void,
      beforeDroidSteerConsume: () => hooks.beforeConsume ?? Effect.void,
      afterPromptRpcSucceeded: () => hooks.promptReturn ?? Effect.void,
    },
    instanceId,
    settings: yield* decodeDroidSettings({
      enabled: true,
      binaryPath: peer.binaryPath,
    }),
    environment: { PATH: process.env.PATH },
    sensitiveEnvironmentValues: [],
    makeRuntime: (input: Parameters<DroidAdapterV2Options["makeRuntime"]>[0]) =>
      makeDroidAcpRuntime({
        ...input,
        protocolLogging: {
          logIncoming: true,
          logOutgoing: true,
          logger: (event) =>
            Effect.sync(() => {
              protocol.push(event);
              Queue.offerUnsafe(decodedQueue, event);
            }),
        },
      }).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          cancel: Effect.suspend(() =>
            (hooks.cancel ?? Effect.void).pipe(
              Effect.andThen(runtime.cancel),
              Effect.andThen(hooks.afterCancel ?? Effect.void),
              Effect.andThen(
                hooks.failAfterCancel
                  ? Effect.fail(
                      new AcpTransportError({
                        operation: "call-rpc",
                        method: "session/cancel",
                        cause: "Synthetic uncertainty after actual cancel",
                      }),
                    )
                  : Effect.void,
              ),
            ),
          ),
        })),
      ),
    childProcessSpawner: spawner,
    selfInvocation: yield* resolveSelfInvocation(),
    onAuthenticationRejected: () => Effect.die("Synthetic Droid must not authenticate"),
  } satisfies DroidAdapterV2Options;
  const nativeAdapter = yield* makeDroidAdapterV2(adapterOptions);
  const terminalProbes: Array<{
    attemptId: RunAttemptId;
    status: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["droidSteerTerminalHeld"]>>[1];
    held: boolean;
  }> = [];
  const adapter = {
    ...nativeAdapter,
    openSession: (input: Parameters<typeof nativeAdapter.openSession>[0]) =>
      nativeAdapter.openSession(input).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          startTurn: (turn: ProviderAdapterV2TurnInput) =>
            runtime
              .startTurn(turn)
              .pipe(Effect.andThen(Effect.suspend(() => hooks.afterStart?.(turn) ?? Effect.void))),
          ...(runtime.configureDroidSteerOwner === undefined
            ? {}
            : {
                configureDroidSteerOwner: (
                  owner: Parameters<
                    NonNullable<ProviderAdapterV2SessionRuntime["configureDroidSteerOwner"]>
                  >[0],
                ) =>
                  runtime.configureDroidSteerOwner!(owner).pipe(
                    Effect.andThen(Effect.suspend(() => hooks.ownerConfigured ?? Effect.void)),
                  ),
              }),
          ...(runtime.droidSteerTerminalHeld === undefined
            ? {}
            : {
                droidSteerTerminalHeld: (
                  attemptId: RunAttemptId,
                  status: Parameters<
                    NonNullable<ProviderAdapterV2SessionRuntime["droidSteerTerminalHeld"]>
                  >[1],
                ) =>
                  runtime.droidSteerTerminalHeld!(attemptId, status).pipe(
                    Effect.tap((held) =>
                      Effect.suspend(() => {
                        const probe = { attemptId, status, held };
                        terminalProbes.push(probe);
                        return hooks.terminalProbe?.(probe) ?? Effect.void;
                      }),
                    ),
                  ),
              }),
        })),
      ),
  };
  const otherAdapter = yield* makeDroidAdapterV2({
    ...adapterOptions,
    instanceId: otherSelection.instanceId,
  });
  const databaseLayer = SqlitePersistenceMemory;
  const services = yield* Layer.build(
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name: `droid-steer-${name}`, runtimePolicyOverride: { cwd } },
      makeLayer([adapter, otherAdapter]),
      {
        configureMcp: false,
        runEffectWorker: false,
        layerDatabase: databaseLayer,
        runtimePolicyLayer: policyLayer,
        layerServerConfig: Layer.succeed(Config.ServerConfig, config),
        ...(name === "policy"
          ? {
              threads: {
                // The captured-policy case has no children; preserve native Stop's outbox seam.
                stopDelegatedTasks: (input: {
                  readonly threadId: ThreadId;
                  readonly commandId: CommandId;
                }) =>
                  Effect.sync(() => {
                    assert.equal(input.threadId, threadId);
                    assert.equal(input.commandId, CommandId.make(`${name}:stop`));
                    stoppedDelegatedTaskParents.push(input.threadId);
                  }),
              },
            }
          : {}),
      },
    ).pipe(Layer.provideMerge(Layer.merge(databaseLayer, threadCommandExecutorLayer))),
  );
  const locks = Context.get(services, ThreadCommandExecutor);
  const actualWithLock = locks.withLock;
  const lockTrace: Array<{ phase: string; id: number; key: ThreadId }> = [];
  let nextLockId = 0;
  const observeWithLock: ThreadCommandExecutor["Service"]["withLock"] = (key, effect) =>
    Effect.suspend(() => {
      const id = ++nextLockId;
      lockTrace.push({ phase: "requested", id, key });
      return (hooks.lockRequested ?? Effect.void).pipe(
        Effect.andThen(
          actualWithLock(
            key,
            Effect.sync(() => {
              lockTrace.push({ phase: "acquired", id, key });
            }).pipe(
              Effect.andThen(Effect.suspend(() => hooks.lockAcquired ?? Effect.void)),
              Effect.andThen(effect),
            ),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            lockTrace.push({ phase: "released", id, key });
          }),
        ),
      );
    });
  // Observe the exact shared executor object; every acquisition still delegates
  // to its real nonrecursive keyed semaphore.
  Object.assign(locks, { withLock: observeWithLock });
  const orchestrator = Context.get(services, OrchestratorV2);
  const rawWorker = Context.get(services, OrchestrationEffectWorkerV2);
  // Outbox deadlines are wall-clock (Date.now) instants, but timers run on the event
  // loop's monotonic clock and can wake before the deadline (libuv/libuv#4773), so a
  // drain after one sleep may claim nothing. Re-read the deadline until it has passed.
  // Returns false when no pending effect remains to wait for.
  const awaitClaimable = Effect.gen(function* () {
    while (true) {
      const deadline = yield* rawWorker.nextClaimableAt;
      if (Option.isNone(deadline)) return false;
      const wait =
        DateTime.toEpochMillis(deadline.value) - DateTime.toEpochMillis(yield* DateTime.now);
      if (wait <= 0) return true;
      yield* Effect.sleep(wait);
    }
  });
  const worker = {
    ...rawWorker,
    drain: (maxEffects = 12) =>
      Effect.gen(function* () {
        yield* awaitClaimable;
        let drained = yield* rawWorker.drain(maxEffects);
        // An admitted cancel may settle natively before its canonical turn update is ingested.
        for (let remaining = maxEffects; remaining > 0; remaining--) {
          const p = yield* Context.get(services, OrchestratorV2).getThreadProjection(threadId);
          if (!p.runs.some((run) => run.heldDroidSteer?.phase === "pre_admission")) break;
          if (!(yield* awaitClaimable)) break;
          drained += yield* rawWorker.drain(maxEffects);
        }
        return drained;
      }),
  };
  const receipts = Context.get(services, CommandReceiptStoreV2);
  const outbox = Context.get(services, EffectOutboxV2);
  const sql = Context.get(services, SqlClient.SqlClient);
  const eventStore = Context.get(services, EventStoreV2);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${name}:create`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  const waitFor = Effect.fnUntraced(function* (
    predicate: (p: OrchestrationV2ThreadProjection) => boolean,
  ) {
    const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
    return yield* Stream.concat(
      Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
      orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence })
        .pipe(Stream.mapEffect(() => orchestrator.getThreadProjection(threadId))),
    ).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.timeout("15 seconds"),
      Effect.map((found) => {
        assert.ok(Option.isSome(found));
        return found.value;
      }),
      Effect.tapError(() =>
        orchestrator
          .getThreadProjection(threadId)
          .pipe(Effect.tap((p) => Effect.log("DROID_STEER_TIMEOUT", encodeNativeJson(p)))),
      ),
    );
  });
  type DispatchOverrides = Partial<
    Pick<
      Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
      | "modelSelection"
      | "runtimeMode"
      | "interactionMode"
      | "context"
      | "attachments"
      | "selectedScientSkillNames"
      | "dispatchMode"
    >
  >;
  const send = Effect.fnUntraced(function* (
    text: string,
    target?: RunId,
    queued = false,
    overrides: DispatchOverrides = {},
  ) {
    const commandId = CommandId.make(`${name}:send:${text}`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId,
      threadId,
      messageId: MessageId.make(`${name}:message:${text}`),
      text,
      attachments: [],
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      dispatchMode: target
        ? { type: "steer_active", targetRunId: target }
        : { type: queued ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      ...overrides,
    });
    const receipt = yield* receipts.getByCommandId(commandId);
    assert.ok(Option.isSome(receipt));
    assert.equal(receipt.value.status, "accepted");
    return commandId;
  });
  const wire = peer
    .readLog()
    .pipe(
      Effect.map((log) =>
        log.flatMap((row) =>
          row.method === "session/cancel"
            ? ["cancel"]
            : row.method === "session/prompt"
              ? [userText(decodeNativePrompt(row.params).prompt[0]!.text)]
              : [],
        ),
      ),
    );
  const observe = Effect.fnUntraced(function* (phase: string, commandId: CommandId) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const commandEffects = yield* outbox.listByCommandId(commandId);
    const runs = yield* sql<{
      run_id: string;
      status: string;
      payload_json: string;
    }>`SELECT run_id, status, payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} ORDER BY ordinal`;
    const attempts =
      yield* sql`SELECT attempt_id, run_id, status FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${threadId} ORDER BY attempt_ordinal`;
    const scopes = yield* sql<{
      scope_id: string;
      payload_json: string;
    }>`SELECT scope_id, payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id = ${threadId} ORDER BY scope_id`;
    for (const row of runs) {
      const persisted = decodeRunJson(row.payload_json);
      const projected = projection.runs.find((run) => run.id === row.run_id)!;
      assert.equal(persisted.status, row.status);
      assert.equal(persisted.activeAttemptId, projected.activeAttemptId);
      assert.deepEqual(persisted.heldDroidSteer, projected.heldDroidSteer);
    }
    const nodes =
      yield* sql`SELECT node_id, status, payload_json FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId} ORDER BY node_id`;
    const allEffects =
      yield* sql`SELECT effect_id, command_id, status, payload_json FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} ORDER BY effect_id`;
    const events = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
    const phases = (yield* fs.readFileString(`${controls}/phases.ndjson`))
      .trim()
      .split("\n")
      .map((line) => decodePhase(line));
    const trace = yield* wire;
    const snapshot = {
      name,
      phase,
      commandId,
      commandEffects,
      runs,
      attempts,
      scopes,
      nodes,
      allEffects,
      events,
      pids,
      terminalProbes,
      lockTrace,
      projection,
      outgoing: protocol.filter((event) => event.direction === "outgoing"),
      trace,
      phases,
      tools: projection.turnItems.filter((item) => item.type === "command_execution"),
      decoded: protocol.filter(
        (event) => event.direction === "incoming" && event.stage === "decoded",
      ),
    };
    yield* record(phase, snapshot);
    yield* Effect.log("DROID_STEER_CAUSAL", encodeNativeJson(snapshot));
    if (name !== "policy")
      assert.isTrue(
        phases.every(
          (native) =>
            native.cwd === cwd && native.model === selection.model && native.autonomy === "normal",
        ),
      );
    return {
      projection,
      commandEffects,
      trace,
      runs,
      scopes,
      phases,
      nodes,
      allEffects,
      events,
      lockTrace,
      terminalProbes,
    };
  });
  const release = (gate: string) => fs.writeFileString(`${controls}/${gate}`, "release");
  const start = Effect.fnUntraced(function* () {
    const commandId = yield* send("first");
    yield* worker.drain(12);
    const initial = yield* waitFor((p) =>
      variant === "background" || variant === "foreground-task"
        ? p.subagents.some((agent) => agent.status === "running")
        : p.turnItems.some(
            (item) =>
              item.type === "command_execution" &&
              item.nativeItemRef?.nativeId === "run" &&
              item.status === "running",
          ),
    );
    assert.lengthOf(initial.runs, 1);
    assert.lengthOf(initial.attempts, 1);
    assert.equal(initial.runs[0]!.status, "running");
    assert.equal(initial.runs[0]!.runtimeMode, "approval-required");
    assert.equal(initial.providerTurns[0]!.runAttemptId, initial.attempts[0]!.id);
    assert.isTrue(
      protocol.some(
        (event) =>
          event.direction === "incoming" &&
          event.stage === "decoded" &&
          JSON.stringify(event.payload).includes(
            variant === "background" || variant === "foreground-task" ? '"Task"' : '"in_progress"',
          ),
      ),
    );
    assert.isTrue(
      (yield* outbox.listByCommandId(commandId)).some(
        (effect) => effect.request.type === "provider-turn.start" && effect.status === "succeeded",
      ),
    );
    yield* observe("native-tool-observed-before-steer", commandId);
    return initial;
  });
  const waitDecoded = (predicate: (event: AcpProtocolLogEvent) => boolean) =>
    Stream.concat(Stream.fromIterable(protocol), Stream.fromQueue(decodedQueue)).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.timeout("15 seconds"),
      Effect.tapError(() =>
        Effect.gen(function* () {
          yield* Effect.log(
            "DROID_DECODE_TIMEOUT",
            encodeNativeJson({
              projection: yield* orchestrator.getThreadProjection(threadId),
              wire: yield* wire,
              native: yield* peer.readLog(),
              phases: yield* fs.readFileString(`${controls}/phases.ndjson`),
            }),
          );
        }),
      ),
    );
  const manager = Context.get(services, ProviderSessionManagerV2);
  const stop = (runId: RunId) =>
    orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`${name}:stop`),
      threadId,
      runId,
      holdQueue: true,
    });
  const native = (initial: OrchestrationV2ThreadProjection) =>
    Effect.gen(function* () {
      const sessionId = initial.providerThreads.find(
        (thread) => thread.id === initial.runs[0]!.providerThreadId,
      )!.providerSessionId!;
      const owner = yield* manager.get(sessionId);
      assert.ok(Option.isSome(owner));
      return owner.value;
    });
  return {
    name,
    threadId,
    cwd,
    fs,
    config,
    nativePrompts: peer
      .readLog()
      .pipe(Effect.map((log) => log.filter((row) => row.method === "session/prompt"))),
    selection,
    otherSelection,
    setPolicyCwd: (next: string) => {
      policyCwd = next;
    },
    orchestrator,
    worker,
    outbox,
    receipts,
    sql,
    manager,
    hooks,
    pids,
    terminalProbes,
    lockTrace,
    stoppedDelegatedTaskParents,
    send,
    waitFor,
    waitDecoded,
    wire,
    protocol,
    release,
    observe,
    record,
    start,
    stop,
    native,
  };
});

const heldOwner = (
  p: OrchestrationV2ThreadProjection,
  initial: OrchestrationV2ThreadProjection,
) => {
  const run = p.runs.find((run) => run.id === initial.runs[0]!.id)!;
  assert.equal(run.status, "running");
  assert.equal(
    run.activeAttemptId,
    initial.runs[0]!.activeAttemptId,
    "Live native work must keep its current attempt while Steer is held",
  );
  assert.lengthOf(
    p.attempts.filter((attempt) => attempt.runId === run.id),
    1,
  );
  assert.equal(run.userMessageId, initial.runs[0]!.userMessageId);
  assert.equal(run.rootNodeId, initial.runs[0]!.rootNodeId);
  assert.equal(run.providerThreadId, initial.runs[0]!.providerThreadId);
  assert.deepEqual(run.modelSelection, initial.runs[0]!.modelSelection);
  assert.equal(p.attempts.find((attempt) => attempt.id === run.activeAttemptId)!.status, "running");
  assert.lengthOf(
    p.turnItems.filter(
      (item) =>
        item.type === "system_notice" &&
        item.message === "Follow-up held until Droid reaches a safe boundary.",
    ),
    1,
  );
};

it.live(
  "holds explicit native Droid Steer through current tool completion without cancelling live work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture("g1");
        const initial = yield* h.start();
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        yield* h.worker.drain(12);
        const held = yield* h.observe("steer-effect-ingested-tool-still-open", command);
        assert.isTrue(
          held.commandEffects.some(
            (effect) => effect.status === "succeeded" || effect.status === "pending",
          ),
        );
        assert.deepEqual(
          held.trace,
          ["first"],
          "No cancel or follow-up while the native tool is unfinished",
        );
        heldOwner(held.projection, initial);
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        yield* h.worker.drain(12);
        yield* h.waitFor((p) => p.attempts.length === 2 && p.runs[0]?.status === "running");
        yield* h.waitDecoded(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "decoded" &&
            JSON.stringify(event.payload).includes("native prompt: follow-up"),
        );
        assert.deepEqual(yield* h.wire, ["first", "cancel", "follow-up"]);
        yield* h.release("finish-prompt");
        yield* h.waitFor((p) => p.runs[0]?.status === "waiting");
        yield* h.worker.drain(12);
        const settled = yield* h.waitFor((p) => p.runs[0]?.status === "completed");
        assert.lengthOf(settled.runs, 1);
        assert.equal(settled.runs[0]!.id, initial.runs[0]!.id);
        assert.deepEqual(
          settled.attempts.map((attempt) => attempt.status),
          ["superseded", "completed"],
        );
      }),
    ).pipe(Effect.provide(outer)),
);

it.live(
  "keeps native Droid Steer held across old-complete and next-active in one decoded child write",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture("g2");
        const initial = yield* h.start();
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        // The canonical command is committed; the real worker has not claimed it yet.
        assert.isTrue(
          (yield* h.outbox.listByCommandId(command)).some((effect) => effect.status === "pending"),
        );
        yield* h.release("handoff");
        yield* h.waitFor(
          (p) =>
            p.turnItems.some(
              (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
            ) &&
            p.turnItems.some(
              (item) => item.nativeItemRef?.nativeId === "next" && item.status === "running",
            ),
        );
        assert.isTrue(
          h.protocol.some((event) => {
            if (
              event.direction !== "incoming" ||
              event.stage !== "decoded" ||
              !Array.isArray(event.payload)
            )
              return false;
            const batch = JSON.stringify(event.payload);
            return (
              batch.includes('"toolCallId":"run"') &&
              batch.includes('"status":"completed"') &&
              batch.includes('"toolCallId":"next"') &&
              batch.includes('"status":"in_progress"')
            );
          }),
          "Both native tool transitions must be in one actual decoder batch",
        );
        yield* h.observe("coalesced-pair-persisted-before-worker-claim", command);
        yield* h.worker.drain(12);
        const held = yield* h.observe("coalesced-handoff-ingested-before-steer-worker", command);
        assert.deepEqual(
          held.trace,
          ["first"],
          "The newly active step must prevent cancellation after old completion",
        );
        heldOwner(held.projection, initial);
        yield* h.release("finish-next");
        yield* h.waitFor((p) =>
          ["run", "next"].every((id) =>
            p.turnItems.some(
              (item) => item.nativeItemRef?.nativeId === id && item.status === "completed",
            ),
          ),
        );
        yield* h.worker.drain(12);
        yield* h.waitFor((p) => p.attempts.length === 2 && p.runs[0]?.status === "running");
        yield* h.waitDecoded(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "decoded" &&
            JSON.stringify(event.payload).includes("native prompt: follow-up"),
        );
        assert.deepEqual(yield* h.wire, ["first", "cancel", "follow-up"]);
      }),
    ).pipe(Effect.provide(outer)),
);

it.live(
  "replaces only the newest held native Droid Steer while retaining two canonical FIFO messages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture("g6");
        const initial = yield* h.start();
        yield* h.send("fifo-1", undefined, true);
        yield* h.send("fifo-2", undefined, true);
        const before = yield* h.orchestrator.getThreadProjection(h.threadId);
        const queued = before.runs
          .filter((run) => run.status === "queued")
          .map((run) => [run.id, run.userMessageId, run.queuePosition]);
        assert.lengthOf(queued, 2);
        yield* h.send("older", initial.runs[0]!.id);
        yield* h.worker.drain(12);
        yield* h.waitFor(
          (p) => p.runs.find((run) => run.id === initial.runs[0]!.id)?.status === "running",
        );
        const newest = yield* h.send("newer", initial.runs[0]!.id);
        yield* h.worker.drain(12);
        const held = yield* h.observe("two-steers-ingested-with-two-fifo-runs", newest);
        assert.deepEqual(
          held.projection.runs
            .filter((run) => run.status === "queued")
            .map((run) => [run.id, run.userMessageId, run.queuePosition]),
          queued,
        );
        assert.deepEqual(
          held.trace,
          ["first"],
          "Neither held Steer may reach the peer before safe release",
        );
        heldOwner(held.projection, initial);
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        // Complete the current outbox request even if the obsolete revision is due first.
        yield* advance(h, initial, newest);
        yield* h.waitFor(
          (p) =>
            p.attempts.filter((attempt) => attempt.runId === initial.runs[0]!.id).length === 2 &&
            p.runs.find((run) => run.id === initial.runs[0]!.id)?.status === "running",
        );
        yield* h.waitDecoded(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "decoded" &&
            JSON.stringify(event.payload).includes("native prompt: newer"),
        );
        assert.deepEqual(yield* h.wire, ["first", "cancel", "newer"]);
        assert.isFalse((yield* h.wire).includes("older"));
        assert.deepEqual(
          (yield* h.orchestrator.getThreadProjection(h.threadId)).runs
            .filter((run) => run.status === "queued")
            .map((run) => [run.id, run.userMessageId, run.queuePosition]),
          queued,
        );
      }),
    ).pipe(Effect.provide(outer)),
);

type Harness = Effect.Success<ReturnType<typeof fixture>>;
const barrier = Effect.fnUntraced(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<void>();
  return {
    exited: Deferred.await(exited).pipe(Effect.timeout("15 seconds")),
    entered: Deferred.await(entered).pipe(Effect.timeout("15 seconds")),
    park: Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.ensuring(Deferred.succeed(exited, undefined)),
    ),
    release: Deferred.succeed(release, undefined),
  };
});
const advance = Effect.fnUntraced(function* (
  h: Harness,
  initial: OrchestrationV2ThreadProjection,
  command: CommandId,
  nativeWitness?: (event: AcpProtocolLogEvent) => boolean,
) {
  for (let remaining = 8; remaining > 0; remaining--) {
    yield* h.worker.drain(12);
    if (!(yield* h.outbox.listByCommandId(command)).some((effect) => effect.status === "pending"))
      break;
  }
  const adopted = yield* h.waitFor(
    (p) =>
      p.runs.find((run) => run.id === initial.runs[0]!.id)?.activeAttemptId !==
        initial.runs[0]!.activeAttemptId &&
      p.runs.find((run) => run.id === initial.runs[0]!.id)?.status === "running",
  );
  const message = adopted.messages.find(
    (message) =>
      message.id === adopted.runs.find((run) => run.id === initial.runs[0]!.id)!.userMessageId,
  )!;
  yield* h.waitDecoded(
    (event) =>
      event.direction === "incoming" &&
      event.stage === "decoded" &&
      (nativeWitness?.(event) ??
        JSON.stringify(event.payload).includes(`native prompt: ${message.text}`)),
  );
  assert.isTrue(
    (yield* h.outbox.listByCommandId(command)).some((effect) => effect.status === "succeeded"),
  );
  return adopted;
});
const nativeCase = <E, R>(
  name: string,
  variant: string,
  test: (h: Harness) => Effect.Effect<void, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* test(yield* fixture(name, variant));
    }),
  ).pipe(
    Effect.provide(outer),
    Effect.withLogger(
      Logger.withConsoleLog(
        Logger.make(
          ({ message }) => `DROID_STEER_DIAGNOSTIC ${NodeUtil.inspect(message, { depth: 12 })}`,
        ),
      ),
    ),
  );

it.live(
  "blocks a ready SQL snapshot while the real decoded-array reader is parked before its first member",
  () =>
    nativeCase("batch-reader", "normal", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        const gate = yield* barrier();
        h.hooks.batchBegin = gate.park;
        yield* h.release("handoff");
        yield* gate.entered;
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        yield* h.worker.drain(12);
        const parked = yield* h.observe("decoded-array-open-before-member-one", command);
        heldOwner(parked.projection, initial);
        assert.deepEqual(parked.trace, ["first"]);
        assert.isTrue(parked.commandEffects.some((effect) => effect.status === "pending"));
        h.hooks.batchBegin = undefined;
        yield* gate.release;
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "next" && item.status === "running",
          ),
        );
        yield* h.worker.drain(12);
        heldOwner(yield* h.orchestrator.getThreadProjection(h.threadId), initial);
        assert.deepEqual(yield* h.wire, ["first"]);
        yield* h.release("finish-next");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "next" && item.status === "completed",
          ),
        );
        yield* advance(h, initial, command);
        assert.deepEqual(yield* h.wire, ["first", "cancel", "follow-up"]);
      }),
    ),
);

it.live.each(
  (["probe", "pre-admission"] as const).map((window) => ({
    caseTitle: `retains the original native owner when new work invalidates Droid readiness at ${window}`,
    window,
  })),
)("$caseTitle", ({ window }) =>
  nativeCase(`race-${window}`, "normal", (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      const command = yield* h.send("follow-up", initial.runs[0]!.id);
      yield* h.release("finish-run");
      yield* h.waitFor((p) =>
        p.turnItems.some(
          (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
        ),
      );
      const gate = yield* barrier();
      if (window === "probe") h.hooks.afterReserve = gate.park;
      else h.hooks.beforeConsume = gate.park;
      const execution = yield* h.worker.runOnce.pipe(Effect.forkScoped);
      yield* gate.entered;
      const claimed = yield* h.observe(`parked-${window}`, command);
      heldOwner(claimed.projection, initial);
      assert.equal(
        claimed.projection.runs[0]!.heldDroidSteer!.phase,
        window === "probe" ? "held" : "pre_admission",
      );
      yield* h.release("handoff");
      yield* h.waitFor((p) =>
        p.turnItems.some(
          (item) => item.nativeItemRef?.nativeId === "next" && item.status === "running",
        ),
      );
      h.hooks.afterReserve = undefined;
      h.hooks.beforeConsume = undefined;
      yield* gate.release;
      yield* Fiber.join(execution);
      const deferred = yield* h.observe(`invalidated-${window}`, command);
      heldOwner(deferred.projection, initial);
      assert.equal(deferred.projection.runs[0]!.heldDroidSteer!.phase, "held");
      assert.deepEqual(deferred.trace, ["first"]);
      assert.isTrue(deferred.commandEffects.some((effect) => effect.status === "pending"));
      // A legitimate long hold cannot exhaust the worker's ordinary five failure attempts.
      for (let attempts = 0; attempts < 6; attempts++) yield* h.worker.drain(12);
      assert.isTrue(
        (yield* h.outbox.listByCommandId(command)).some(
          (effect) => effect.status === "pending" && effect.attemptCount > 5,
        ),
      );
      yield* h.release("finish-next");
      yield* h.waitFor((p) =>
        p.turnItems.some(
          (item) => item.nativeItemRef?.nativeId === "next" && item.status === "completed",
        ),
      );
      yield* advance(h, initial, command);
      assert.deepEqual(yield* h.wire, ["first", "cancel", "follow-up"]);
    }),
  ),
);

it.live.each(
  (["completed", "failed", "stopped"] as const).map((outcome) => ({
    caseTitle: `releases held Droid input on actual prompt return without cancel; the replacement is ${outcome}`,
    outcome,
  })),
)("$caseTitle", ({ outcome }) =>
  nativeCase(`returned-${outcome}`, "normal", (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      const command = yield* h.send("follow-up", initial.runs[0]!.id);
      const gate = yield* barrier();
      h.hooks.promptReturn = gate.park;
      yield* h.release("finish-first");
      yield* gate.entered;
      const adopted = yield* advance(h, initial, command);
      assert.deepEqual(yield* h.wire, ["first", "follow-up"]);
      assert.equal(
        adopted.providerTurns.find((turn) => turn.runAttemptId === initial.attempts[0]!.id)!.status,
        "completed",
      );
      assert.isTrue(
        adopted.turnItems.some(
          (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
        ),
      );
      h.hooks.promptReturn = undefined;
      yield* gate.release;
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(h.threadId)).runs[0]!.activeAttemptId,
        adopted.runs[0]!.activeAttemptId,
      );
      if (outcome === "stopped") {
        yield* h.stop(initial.runs[0]!.id);
        yield* h.worker.drain(12);
      } else {
        yield* h.release(outcome === "completed" ? "finish-prompt" : "fail-prompt");
      }
      if (outcome === "completed") {
        yield* h.waitFor((p) => p.runs[0]?.status === "waiting");
        yield* h.worker.drain(12);
      }
      const final = yield* h.waitFor(
        (p) => p.runs[0]?.status === (outcome === "stopped" ? "interrupted" : outcome),
      );
      assert.deepEqual(
        final.attempts.map((attempt) => attempt.status),
        ["superseded", outcome === "stopped" ? "interrupted" : outcome],
      );
      assert.lengthOf(final.runs, 1);
      assert.isUndefined(final.runs[0]!.heldDroidSteer);
      assert.isFalse(
        final.turnItems.some(
          (item) =>
            item.providerTurnId === final.providerTurns.at(-1)?.id &&
            ["pending", "running", "waiting"].includes(item.status),
        ),
      );
      yield* h.observe(`replacement-${outcome}-terminal`, command);
    }),
  ),
);

it.live.each(
  (["old-live", "late", "reannounce", "foreground-task"] as const).map((variant) => ({
    caseTitle: `resets native Droid prompt safety after ${variant} and does not resurrect that prompt's tool in its replacement`,
    variant,
  })),
)("$caseTitle", ({ variant }) =>
  nativeCase(`reset-${variant}`, variant, (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      yield* h.send("follow-up", initial.runs[0]!.id);
      // The actual native response is observed separately from canonical replacement ownership.
      const owner = yield* h.native(initial);
      const returned = yield* barrier();
      h.hooks.promptReturn = returned.park;
      yield* h.release("finish-first");
      yield* returned.entered;
      yield* h.worker.drain(12);
      const second = yield* h.waitFor(
        (p) =>
          p.runs[0]?.activeAttemptId !== initial.runs[0]!.activeAttemptId &&
          p.runs[0]?.status === "running",
      );
      yield* h.waitDecoded(
        (event) =>
          event.direction === "incoming" &&
          event.stage === "decoded" &&
          JSON.stringify(event.payload).includes("native prompt: follow-up"),
      );
      yield* h.waitFor((p) =>
        p.providerTurns.some(
          (turn) =>
            turn.runAttemptId === second.runs[0]!.activeAttemptId && turn.status === "running",
        ),
      );
      h.hooks.promptReturn = undefined;
      yield* returned.release;
      yield* returned.exited;
      const third = yield* h.send("third", initial.runs[0]!.id);
      yield* h.worker.drain(12);
      const thirdRunning = yield* h.waitFor(
        (p) =>
          p.attempts.filter((attempt) => attempt.runId === initial.runs[0]!.id).length === 3 &&
          p.runs[0]?.status === "running",
      );
      assert.notEqual(thirdRunning.runs[0]!.activeAttemptId, second.runs[0]!.activeAttemptId);
      yield* h.waitDecoded(
        (event) =>
          event.direction === "incoming" &&
          event.stage === "decoded" &&
          JSON.stringify(event.payload).includes("native prompt: third"),
      );
      assert.deepEqual(yield* h.wire, ["first", "follow-up", "cancel", "third"]);
      assert.isFalse(
        thirdRunning.turnItems.some(
          (item) =>
            item.providerTurnId === second.providerTurns.at(-1)?.id &&
            item.nativeItemRef?.nativeId === "run" &&
            item.status === "running",
        ),
      );
      assert.isFalse(owner.droidSteerConsumed?.("unrelated") ?? false);
      yield* h.release("finish-prompt");
      yield* h.waitFor((p) => p.runs[0]?.status === "waiting");
      yield* h.worker.drain(12);
      const final = yield* h.waitFor((p) => p.runs[0]?.status === "completed");
      assert.deepEqual(
        final.attempts.map((attempt) => attempt.status),
        ["superseded", "superseded", "completed"],
      );
      assert.lengthOf(
        final.turnItems.filter(
          (item) =>
            item.type === "system_notice" &&
            item.message === "Follow-up held until Droid reaches a safe boundary.",
        ),
        1,
      );
      yield* h.observe(`reset-${variant}-final`, third);
    }),
  ),
);

it.live(
  "keeps native Task launch, running checks, unknown tasks and another session from releasing the held Droid intent",
  () =>
    nativeCase("background", "background", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        yield* h.worker.drain(12);
        heldOwner(yield* h.orchestrator.getThreadProjection(h.threadId), initial);
        assert.deepEqual(yield* h.wire, ["first"]);
        for (const gate of ["bg-running", "bg-unknown", "bg-other"] as const) {
          yield* h.release(gate);
          if (gate === "bg-other")
            yield* h.waitDecoded(
              (event) =>
                event.direction === "incoming" &&
                event.stage === "decoded" &&
                JSON.stringify(event.payload).includes('"sessionId":"another"'),
            );
          if (gate !== "bg-other")
            yield* h.waitFor(
              (p) =>
                p.subagents.some((agent) => agent.status === "running") &&
                p.turnItems.some(
                  (item) =>
                    item.nativeItemRef?.nativeId === (gate === "bg-running" ? "check" : "unknown"),
                ),
            );
          yield* h.worker.drain(12);
          heldOwner(yield* h.orchestrator.getThreadProjection(h.threadId), initial);
          assert.deepEqual(yield* h.wire, ["first"]);
        }
        yield* h.release("bg-completed");
        const completed = yield* h.waitFor((p) =>
          p.subagents.some(
            (agent) => agent.status === "completed" && agent.result?.includes("The host is sound."),
          ),
        );
        assert.equal(completed.subagents[0]!.nativeTaskRef?.nativeId, "task");
        yield* advance(h, initial, command);
        yield* h.waitDecoded(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "decoded" &&
            JSON.stringify(event.payload).includes("native prompt: follow-up"),
        );
        assert.deepEqual(yield* h.wire, ["first", "cancel", "follow-up"]);
        assert.isFalse(
          (yield* h.orchestrator.getThreadProjection(h.threadId)).subagents.some(
            (agent) => agent.status === "cancelled",
          ),
        );
        yield* h.observe("matching-native-background-report-released-once", command);
      }),
    ),
);

it.live.each(
  (["held", "probe", "pre-admission"] as const).map((window) => ({
    caseTitle: `lets canonical Stop win at ${window} without delivering the held native Droid prompt`,
    window,
  })),
)("$caseTitle", ({ window }) =>
  nativeCase(`stop-${window}`, "normal", (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      const command = yield* h.send("follow-up", initial.runs[0]!.id);
      const gate = yield* barrier();
      if (window !== "held") {
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        if (window === "probe") h.hooks.afterReserve = gate.park;
        else h.hooks.beforeConsume = gate.park;
        yield* h.worker.runOnce.pipe(Effect.forkScoped);
        yield* gate.entered;
      } else yield* h.worker.drain(12);
      yield* h.stop(initial.runs[0]!.id);
      const stopped = yield* h.orchestrator.getThreadProjection(h.threadId);
      assert.isUndefined(stopped.runs[0]!.heldDroidSteer);
      assert.isTrue(
        (yield* h.outbox.listByCommandId(command)).every(
          (effect) => effect.status === "cancelled" || effect.status === "succeeded",
        ),
      );
      h.hooks.afterReserve = undefined;
      h.hooks.beforeConsume = undefined;
      yield* gate.release;
      yield* h.worker.drain(12);
      const final = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
      assert.lengthOf(final.attempts, 1);
      assert.equal(final.attempts[0]!.status, "interrupted");
      assert.lengthOf(
        final.turnItems.filter(
          (item) =>
            item.type === "system_notice" &&
            item.message === "Your waiting message was not delivered. Send it again to continue.",
        ),
        1,
      );
      assert.isFalse((yield* h.wire).includes("follow-up"));
      yield* h.release("finish-run");
      yield* h.worker.drain(12);
      assert.isFalse((yield* h.wire).includes("follow-up"));
      yield* h.observe(`stop-${window}-settled`, command);
    }),
  ),
);

it.live(
  "finalizes typed native startup failure when held Steer commits after its outside no-hold probe",
  () =>
    nativeCase("finalization-registration-race", "normal", (h) =>
      Effect.gen(function* () {
        const nativeStarted = yield* Deferred.make<void>();
        const failStart = yield* Deferred.make<void>();
        const ownerConfigured = yield* Deferred.make<void>();
        const releaseRegistration = yield* Deferred.make<void>();
        const outsideProbe = yield* Deferred.make<void>();
        const finalizerRequestedLock = yield* Deferred.make<void>();
        let failureProbed = false;
        let captureFirstFinalizerLock = true;
        const firstCommand = CommandId.make(`${h.name}:send:first`);
        const heldCommand = CommandId.make(`${h.name}:send:follow-up`);
        h.hooks.afterStart = (turn) =>
          Deferred.succeed(nativeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(failStart)),
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: turn.providerThread.driver,
                  threadId: turn.threadId,
                  runId: turn.runId,
                  providerThreadId: turn.providerThread.id,
                  cause: "Synthetic typed non-stream failure after actual native start",
                }),
              ),
            ),
          );
        h.hooks.ownerConfigured = Deferred.succeed(ownerConfigured, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRegistration)),
        );
        h.hooks.terminalProbe = (probe) =>
          Effect.gen(function* () {
            if (probe.status === "failed" && !probe.held) {
              failureProbed = true;
              yield* Deferred.succeed(outsideProbe, undefined);
            }
          });
        h.hooks.lockRequested = Effect.suspend(() =>
          failureProbed
            ? Deferred.succeed(finalizerRequestedLock, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        h.hooks.lockAcquired = Effect.suspend(() => {
          if (!failureProbed || !captureFirstFinalizerLock) return Effect.void;
          captureFirstFinalizerLock = false;
          return h.observe("held-SQL-committed-before-first-finalizer-probe", heldCommand).pipe(
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                assert.equal(snapshot.projection.runs[0]!.heldDroidSteer!.revision, heldCommand);
                assert.equal(snapshot.projection.runs[0]!.status, "running");
              }),
            ),
            Effect.asVoid,
            Effect.orDie,
          );
        });
        yield* Effect.gen(function* () {
          yield* h.send("first");
          const startWorker = yield* h.worker.drain(12).pipe(Effect.forkScoped);
          yield* Deferred.await(nativeStarted).pipe(Effect.timeout("15 seconds"));
          const initial = yield* h.waitFor(
            (p) =>
              p.providerTurns.some((turn) => turn.status === "running") &&
              p.turnItems.some(
                (item) => item.type === "command_execution" && item.status === "running",
              ),
          );
          assert.lengthOf(initial.runs, 1);
          assert.lengthOf(initial.attempts, 1);
          assert.equal(initial.runs[0]!.status, "running");
          assert.isUndefined(initial.runs[0]!.heldDroidSteer);
          const owner = yield* h.native(initial);
          assert.isFalse(owner.droidSteerConsumed?.() ?? false);
          const registration = yield* h
            .send("follow-up", initial.runs[0]!.id)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(ownerConfigured).pipe(Effect.timeout("15 seconds"));
          const registrationLock = h.lockTrace.findLast((entry) => entry.phase === "acquired")!;
          assert.isFalse(
            h.lockTrace.some(
              (entry) => entry.id === registrationLock.id && entry.phase === "released",
            ),
          );
          yield* Deferred.succeed(failStart, undefined);
          yield* Deferred.await(outsideProbe).pipe(Effect.timeout("15 seconds"));
          yield* Deferred.await(finalizerRequestedLock).pipe(Effect.timeout("15 seconds"));
          const requested = h.lockTrace.findLast((entry) => entry.phase === "requested")!;
          assert.equal(requested.key, h.threadId);
          assert.isFalse(
            h.lockTrace.some((entry) => entry.id === requested.id && entry.phase === "acquired"),
          );
          const beforeCommit = yield* h.observe(
            "outside-no-hold-probe-while-public-registration-owns-permit",
            firstCommand,
          );
          assert.isUndefined(beforeCommit.projection.runs[0]!.heldDroidSteer);
          assert.equal(beforeCommit.projection.runs[0]!.status, "running");
          assert.deepEqual(beforeCommit.trace, ["first"]);
          assert.deepEqual(h.terminalProbes, [
            { attemptId: initial.attempts[0]!.id, status: "failed", held: false },
          ]);
          yield* Deferred.succeed(releaseRegistration, undefined);
          yield* Fiber.join(registration).pipe(Effect.timeout("15 seconds"));
          yield* Fiber.join(startWorker).pipe(
            Effect.timeout("15 seconds"),
            Effect.tapError(() =>
              h.observe("finalizer-deadline-before-cleanup", heldCommand).pipe(Effect.asVoid),
            ),
          );
          const final = yield* h.observe(
            "non-stream-finalizer-returned-before-cleanup",
            heldCommand,
          );
          assert.equal(final.projection.runs[0]!.status, "failed");
          assert.isUndefined(final.projection.runs[0]!.heldDroidSteer);
          assert.lengthOf(final.projection.runs, 1);
          assert.lengthOf(final.projection.attempts, 1);
          assert.equal(final.projection.attempts[0]!.status, "failed");
          assert.equal(final.projection.runs[0]!.activeAttemptId, initial.runs[0]!.activeAttemptId);
          assert.equal(final.projection.runs[0]!.rootNodeId, initial.runs[0]!.rootNodeId);
          assert.equal(
            final.projection.nodes.find((node) => node.id === initial.runs[0]!.rootNodeId)!.status,
            "failed",
          );
          assert.deepEqual(final.trace, ["first"]);
          assert.lengthOf(
            final.projection.turnItems.filter((item) => item.type === "error"),
            1,
          );
          assert.lengthOf(
            final.projection.turnItems.filter(
              (item) => item.type === "system_notice" && item.message.includes("not delivered"),
            ),
            1,
          );
          assert.lengthOf(
            final.events.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "failed",
            ),
            1,
          );
          assert.isFalse(
            final.commandEffects.some(
              (effect) => effect.status === "pending" || effect.status === "running",
            ),
          );
          assert.isTrue(
            final.commandEffects.some(
              (effect) =>
                effect.request.type === "provider-turn.restart" && effect.status === "succeeded",
            ),
          );
          assert.isTrue(
            h.terminalProbes.some((probe) => probe.status === "completed" && probe.held),
          );
          assert.equal(h.pids.length, 1);
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(failStart, undefined),
              Deferred.succeed(releaseRegistration, undefined),
            ]),
          ),
        );
      }),
    ),
);

it.live("drops held Droid input on actual native failure before old finalization", () =>
  nativeCase("source-failure", "normal", (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      const command = yield* h.send("follow-up", initial.runs[0]!.id);
      yield* h.release("fail-first");
      const final = yield* h.waitFor((p) => p.runs[0]?.status === "failed");
      assert.isUndefined(final.runs[0]!.heldDroidSteer);
      assert.lengthOf(final.attempts, 1);
      yield* h.worker.drain(12);
      assert.deepEqual(yield* h.wire, ["first"]);
      yield* h.observe("native-source-failed-not-replayed", command);
    }),
  ),
);

it.live.each(
  (["registration", "claim"] as const).map((phase) => ({
    caseTitle: `keeps canonical native ownership and offers no Droid input when SQL rejects ${phase}`,
    phase,
  })),
)("$caseTitle", ({ phase }) =>
  nativeCase(`sql-${phase}`, "normal", (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      yield* h.sql
        .unsafe(`CREATE TRIGGER reject_droid BEFORE UPDATE ON orchestration_v2_projection_runs
      WHEN json_extract(NEW.payload_json, '$.heldDroidSteer.phase') = '${phase === "registration" ? "held" : "pre_admission"}'
      BEGIN SELECT RAISE(ABORT, 'synthetic Droid admission rejection'); END`);
      if (phase === "registration") {
        const rejected = yield* h.send("follow-up", initial.runs[0]!.id).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rejected));
        const after = yield* h.orchestrator.getThreadProjection(h.threadId);
        assert.isUndefined(after.runs[0]!.heldDroidSteer);
        assert.lengthOf(after.attempts, 1);
        assert.isFalse(
          after.messages.some(
            (message) => message.id === MessageId.make(`${h.name}:message:follow-up`),
          ),
        );
      } else {
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        yield* h.worker.drain(12);
        const after = yield* h.observe("sql-claim-rejected-before-native-consume", command);
        heldOwner(after.projection, initial);
        assert.equal(after.projection.runs[0]!.heldDroidSteer!.phase, "held");
        assert.isTrue(after.commandEffects.some((effect) => effect.status === "pending"));
        yield* h.sql.unsafe("DROP TRIGGER reject_droid");
        yield* advance(h, initial, command);
      }
      assert.deepEqual((yield* h.wire).slice(0, phase === "registration" ? 3 : 1), ["first"]);
    }),
  ),
);

it.live(
  "does not replay a persisted Droid held intent after process-bound reconciliation or into a fresh native session",
  () =>
    nativeCase("replay", "normal", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        const persisted = yield* h.observe("persisted-held-before-process-loss", command);
        const revision = persisted.projection.runs[0]!.heldDroidSteer!.revision;
        const recovery = yield* h.outbox.reconcileAfterProcessLoss;
        assert.isAtLeast(recovery.cancelled, 1);
        yield* h.worker.drain(12);
        assert.deepEqual(yield* h.wire, ["first"]);
        const sessionId = initial.providerThreads[0]!.providerSessionId!;
        const old = yield* h.native(initial);
        yield* h.manager.close(sessionId);
        const fresh = yield* h.manager.open({
          threadId: h.threadId,
          providerSessionId: sessionId,
          modelSelection: h.selection,
          runtimePolicy: {
            cwd: h.cwd,
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        });
        assert.notEqual(fresh, old);
        assert.isUndefined(
          yield* fresh.reserveDroidSteer!({
            attemptId: initial.attempts[0]!.id,
            providerTurnId: initial.providerTurns[0]!.id,
            revision,
          }),
        );
        assert.isFalse(old.validateDroidSteer?.("retired-token") ?? false);
        yield* h.worker.drain(12);
        assert.deepEqual(yield* h.wire, ["first"]);
        assert.isTrue(
          (yield* h.outbox.listByCommandId(command)).every(
            (effect) => effect.status === "cancelled",
          ),
        );
        yield* h.observe("fresh-owner-has-no-replay-authority", command);
      }),
    ),
);

for (const oldReturn of ["completed", "aborted"] as const)
  it.live.each(
    (["adoption", "replacement-result"] as const).map((releaseOldAfter) => ({
      caseTitle: `preserves actual subparagraph old-answer identity when its ${oldReturn} native return callback resumes after ${releaseOldAfter}`,
      releaseOldAfter,
    })),
  )("$caseTitle", ({ releaseOldAfter }) =>
    nativeCase(`tail-${oldReturn}-${releaseOldAfter}`, "tail", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        yield* h.waitDecoded(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "decoded" &&
            JSON.stringify(event.payload).includes("Keep the old answer."),
        );
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        const gate = yield* barrier();
        h.hooks.promptReturn = gate.park;
        yield* h.release(oldReturn === "completed" ? "finish-first" : "abort-first");
        yield* gate.entered;
        const adopted = yield* advance(h, initial, command);
        const old = adopted.messages.find(
          (message) => message.role === "assistant" && message.text === "Keep the old answer.",
        );
        assert.equal(
          adopted.providerTurns.find((turn) => turn.runAttemptId === initial.attempts[0]!.id)!
            .status,
          oldReturn === "completed" ? "completed" : "cancelled",
        );
        assert.ok(old);
        assert.isFalse(old.streaming);
        assert.equal(
          adopted.nodes.find((node) => node.id === old.nodeId)!.providerTurnId,
          initial.providerTurns[0]!.id,
        );
        assert.equal(
          adopted.nodes.find((node) => node.id === old.nodeId)!.rootNodeId,
          initial.runs[0]!.rootNodeId,
        );
        assert.isFalse(old.text.includes("\n\n"));
        assert.deepEqual(yield* h.wire, ["first", "follow-up"]);
        h.hooks.promptReturn = undefined;
        if (releaseOldAfter === "replacement-result") {
          yield* h.release("finish-prompt");
          yield* h.waitFor((p) => p.runs[0]?.status === "waiting");
          yield* h.worker.drain(12);
          yield* h.waitFor((p) => p.runs[0]?.status === "completed");
        }
        yield* gate.release;
        yield* gate.exited;
        const after = yield* h.orchestrator.getThreadProjection(h.threadId);
        assert.deepEqual(
          after.messages.find((message) => message.id === old.id),
          old,
        );
        assert.equal(after.runs[0]!.activeAttemptId, adopted.runs[0]!.activeAttemptId);
        assert.equal(
          after.runs[0]!.status,
          releaseOldAfter === "adoption" ? "running" : "completed",
        );
        assert.isFalse(after.turnItems.some((item) => item.type === "error"));
        if (releaseOldAfter === "adoption") {
          yield* h.release("finish-prompt");
          yield* h.waitFor((p) => p.runs[0]?.status === "waiting");
          yield* h.worker.drain(12);
          yield* h.waitFor((p) => p.runs[0]?.status === "completed");
        }
        const final = yield* h.observe(
          "late-success-callback-kept-old-bytes-and-new-owner",
          command,
        );
        assert.lengthOf(
          final.projection.messages.filter((message) => message.id === old.id),
          1,
        );
        assert.deepEqual(
          final.projection.attempts.map((attempt) => attempt.status),
          ["superseded", "completed"],
        );
      }),
    ),
  );

it.live(
  "admits the captured Droid instance, model, modes, workspace and exact submitted input despite later defaults",
  () =>
    nativeCase("policy", "normal", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        const targetCwd = yield* h.fs.realPath(
          yield* checkpointWorkspace("droid-steer-policy-target"),
        );
        const futureCwd = yield* h.fs.realPath(
          yield* checkpointWorkspace("droid-steer-policy-future"),
        );
        h.setPolicyCwd(targetCwd);
        const context = decodeMessageContext({
          version: 1,
          records: [
            {
              version: 1,
              contextId: "terminal-proof",
              kind: "terminal",
              label: "Captured terminal",
              terminalId: "terminal-proof",
              terminalLabel: "Captured terminal",
              lineStart: 1,
              lineEnd: 1,
              text: "CAPTURED_CONTEXT_ONLY",
            },
          ],
        });
        const attachment = {
          type: "file" as const,
          id: ChatAttachmentId.make(createDeterministicAttachmentId(h.threadId, "captured-file")!),
          name: "captured.txt",
          mimeType: "text/plain",
          sizeBytes: 14,
        };
        const file = resolveAttachmentPath({
          attachmentsDir: h.config.attachmentsDir,
          attachment,
        })!;
        yield* h.fs.makeDirectory(h.config.attachmentsDir, { recursive: true });
        yield* h.fs.writeFileString(file, "captured bytes");
        const beforeScopes = (yield* h.observe(
          "scope-before-held-policy",
          CommandId.make("policy:send:first"),
        )).scopes;
        const olderSentinel = "OLDER_INTENT_MUST_NOT_REACH_NATIVE";
        yield* h.send(olderSentinel, initial.runs[0]!.id);
        const submittedText =
          "follow-up [Captured terminal](t3-context://v1/terminal/terminal-proof)";
        const command = yield* h.send(submittedText, initial.runs[0]!.id, false, {
          modelSelection: h.otherSelection,
          runtimeMode: "full-access",
          interactionMode: "plan",
          context,
          attachments: [attachment],
          selectedScientSkillNames: [],
        });
        const held = yield* h.observe("captured-target-before-default-change", command);
        heldOwner(held.projection, initial);
        assert.deepEqual(held.scopes, beforeScopes);
        assert.deepEqual(held.projection.runs[0]!.heldDroidSteer!.modelSelection, h.otherSelection);
        assert.equal(held.projection.runs[0]!.heldDroidSteer!.runtimePolicy.cwd, targetCwd);
        const message = held.projection.messages.find(
          (message) => message.id === MessageId.make(`policy:message:${submittedText}`),
        )!;
        h.setPolicyCwd(futureCwd);
        yield* h.orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("policy:defaults"),
          threadId: h.threadId,
          modelSelection: { ...h.selection, model: "droid-future" },
        });
        yield* h.orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("policy:future-mode"),
          threadId: h.threadId,
          runtimeMode: "approval-required",
        });
        yield* h.orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("policy:future-interaction"),
          threadId: h.threadId,
          interactionMode: "default",
        });
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        const adopted = yield* advance(h, initial, command, (event) =>
          JSON.stringify(event.payload).includes("CAPTURED_CONTEXT_ONLY"),
        );
        const target = adopted.runs[0]!;
        assert.deepEqual(target.modelSelection, h.otherSelection);
        assert.equal(target.providerInstanceId, h.otherSelection.instanceId);
        assert.equal(target.runtimeMode, "full-access");
        assert.equal(target.interactionMode, "plan");
        assert.equal(target.steeringRuntimePolicy!.cwd, targetCwd);
        const native = yield* h.observe("captured-target-actually-written", command);
        const targetRoot = adopted.nodes.find((node) => node.id === target.rootNodeId)!;
        const targetScope = native.scopes.find(
          (scope) => scope.scope_id === targetRoot.checkpointScopeId,
        )!;
        assert.equal(decodeCheckpointScopeJson(targetScope.payload_json).cwd, targetCwd);
        assert.deepEqual(
          native.phases.map((phase) => [phase.cwd, phase.model, phase.autonomy]),
          [
            [h.cwd, "droid-native", "normal"],
            [targetCwd, "droid-other", "spec"],
          ],
        );
        const rebound = adopted.messages.find((candidate) => candidate.id === message.id)!;
        assert.deepEqual(rebound.attachments, message.attachments);
        assert.deepEqual(rebound.context, message.context);
        assert.deepEqual(rebound.selectedScientSkillNames, []);
        assert.deepEqual(rebound.createdAt, message.createdAt);
        const nativePrompt = encodeNativeJson((yield* h.nativePrompts).at(-1)!.params);
        assert.include(nativePrompt, "CAPTURED_CONTEXT_ONLY");
        assert.notInclude(nativePrompt, olderSentinel);
        assert.include(nativePrompt, "captured.txt");
        assert.notEqual(
          adopted.providerThreads.find((thread) => thread.id === target.providerThreadId)!
            .providerSessionId,
          initial.providerThreads[0]!.providerSessionId,
        );
        yield* h.send("fifo-1", undefined, true);
        yield* h.send("fifo-2", undefined, true);
        const queued = yield* h.orchestrator.getThreadProjection(h.threadId);
        const fifo = queued.runs.filter((run) => run.status === "queued");
        const fifoMessages = queued.messages.filter((candidate) =>
          fifo.some((run) => run.userMessageId === candidate.id),
        );
        const ordinaryCommand = yield* h.send("ordinary-restart", target.id, false, {
          dispatchMode: { type: "restart_active", targetRunId: target.id },
          modelSelection: h.selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        const replacementStarted = yield* advance(h, adopted, ordinaryCommand, (event) =>
          JSON.stringify(event.payload).includes("ordinary-restart"),
        );
        const ordinary = replacementStarted.runs.find((run) => run.id === target.id)!;
        const restarted = yield* h.waitFor((p) =>
          p.providerTurns.some(
            (turn) => turn.runAttemptId === ordinary.activeAttemptId && turn.status === "running",
          ),
        );
        const ordinaryNative = yield* h.observe("ordinary-restart-native-and-sql", ordinaryCommand);
        const ordinaryRoot = restarted.nodes.find((node) => node.id === ordinary.rootNodeId)!;
        const ordinaryScope = decodeCheckpointScopeJson(
          ordinaryNative.scopes.find((scope) => scope.scope_id === ordinaryRoot.checkpointScopeId)!
            .payload_json,
        );
        assert.equal(ordinaryScope.cwd, futureCwd);
        const ordinaryPhase = ordinaryNative.phases.at(-1)!;
        assert.match(ordinaryPhase.text, /(?:^|User message:\n)ordinary-restart$/u);
        assert.deepEqual(
          [ordinaryPhase.cwd, ordinaryPhase.model, ordinaryPhase.autonomy],
          [futureCwd, h.selection.model, "normal"],
          "The public ordinary restart must use its own workspace and supervised permissions",
        );
        assert.equal(ordinary.runtimeMode, "approval-required");
        assert.equal(ordinary.interactionMode, "default");
        assert.deepEqual(ordinary.modelSelection, h.selection);
        assert.equal(ordinary.providerInstanceId, h.selection.instanceId);
        assert.isUndefined(ordinary.heldDroidSteer);
        assert.isUndefined(ordinary.steeringRuntimePolicy);
        assert.deepEqual(
          decodeRunJson(ordinaryNative.runs.find((run) => run.run_id === target.id)!.payload_json),
          ordinary,
        );
        assert.notEqual(ordinary.activeAttemptId, target.activeAttemptId);
        assert.notEqual(ordinary.rootNodeId, target.rootNodeId);
        assert.equal(
          restarted.attempts.find((attempt) => attempt.id === target.activeAttemptId)!.status,
          "superseded",
        );
        assert.equal(
          restarted.attempts.find((attempt) => attempt.id === ordinary.activeAttemptId)!.status,
          "running",
        );
        assert.equal(
          restarted.providerTurns.find((turn) => turn.runAttemptId === ordinary.activeAttemptId)!
            .nodeId,
          ordinary.rootNodeId,
        );
        assert.deepEqual(restarted.attempts[0], adopted.attempts[0]);
        assert.deepEqual(
          restarted.nodes.find((node) => node.id === initial.runs[0]!.rootNodeId),
          adopted.nodes.find((node) => node.id === initial.runs[0]!.rootNodeId),
        );
        assert.deepEqual(restarted.providerTurns[0], adopted.providerTurns[0]);
        assert.deepEqual(
          restarted.messages.find((candidate) => candidate.id === message.id),
          rebound,
        );
        assert.deepEqual(
          restarted.runs.filter((run) => run.status === "queued"),
          fifo,
        );
        assert.deepEqual(
          restarted.messages.filter((candidate) =>
            fifoMessages.some((old) => old.id === candidate.id),
          ),
          fifoMessages,
        );
        assert.deepEqual(yield* h.wire, [
          "first",
          "cancel",
          native.phases[1]!.text,
          "cancel",
          ordinaryPhase.text,
        ]);
        assert.isEmpty(restarted.subagents);
        yield* h.stop(target.id);
        yield* h.worker.drain(12);
        assert.deepEqual(h.stoppedDelegatedTaskParents, [h.threadId]);
        yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
        yield* h.worker.drain(12);
        const stopped = yield* h.waitFor((p) =>
          p.checkpoints.some(
            (checkpoint) =>
              checkpoint.scopeId === ordinaryScope.id &&
              checkpoint.nodeId === ordinary.rootNodeId &&
              checkpoint.status === "ready" &&
              checkpoint.ordinalWithinScope > 0,
          ),
        );
        const checkpoint = stopped.checkpoints.find(
          (candidate) => candidate.scopeId === ordinaryScope.id && candidate.ordinalWithinScope > 0,
        )!;
        const checkpointRows = yield* h.sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE checkpoint_id = ${checkpoint.id}`;
        assert.deepEqual(decodeCheckpointJson(checkpointRows[0]!.payload_json), checkpoint);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const actualCheckpoint = yield* spawner.string(
          ChildProcess.make("git", ["show", `${checkpoint.ref}:ordinary-restart.txt`], {
            cwd: futureCwd,
          }),
        );
        assert.equal(actualCheckpoint, encodeNativeJson({ cwd: futureCwd, autonomy: "normal" }));
        assert.isFalse(yield* h.fs.exists(`${targetCwd}/ordinary-restart.txt`));
        assert.deepEqual(
          stopped.runs.filter((run) => run.status === "queued"),
          fifo.map((run) => ({ ...run, queueHeld: true })),
        );
        assert.deepEqual(
          stopped.messages.filter((candidate) =>
            fifoMessages.some((old) => old.id === candidate.id),
          ),
          fifoMessages,
        );
        yield* h.observe("ordinary-restart-stopped-with-checkpoint", ordinaryCommand);
        yield* h.record("ordinary-checkpoint-ref-proof", {
          checkpointRows,
          checkpoint,
          ordinaryScope,
          actualCheckpoint,
        });
      }),
    ),
);

it.live.each(
  (["probe", "pre-admission"] as const).map((window) => ({
    caseTitle: `invalidates an older native reservation at ${window} while retaining and then executing both FIFO payloads`,
    window,
  })),
)("$caseTitle", ({ window }) =>
  nativeCase(`newest-${window}`, "normal", (h) => {
    const trace = nativeSettlementTrace(h.threadId, h);
    return Effect.gen(function* () {
      const initial = yield* trace.at("initial-native-owner", h.start());
      trace.admissionCommands.push(yield* h.send("fifo-1", undefined, true));
      trace.admissionCommands.push(yield* h.send("fifo-2", undefined, true));
      const before = yield* h.orchestrator.getThreadProjection(h.threadId);
      const fifo = before.runs.filter((run) => run.status === "queued");
      const fifoMessages = before.messages.filter((message) =>
        fifo.some((run) => run.userMessageId === message.id),
      );
      const older = yield* h.send("older", initial.runs[0]!.id);
      trace.admissionCommands.push(older);
      yield* h.release("finish-run");
      yield* trace.at(
        "original-run-item-completed",
        h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        ),
      );
      const gate = yield* barrier();
      if (window === "probe") h.hooks.afterReserve = gate.park;
      else h.hooks.beforeConsume = gate.park;
      const execution = yield* h.worker.runOnce.pipe(Effect.forkScoped);
      yield* trace.at("older-reservation-entered", gate.entered);
      const newer = yield* h.send("newer", initial.runs[0]!.id);
      trace.admissionCommands.push(newer);
      const registered = yield* h.observe("newest-revision-invalidated-old-reservation", newer);
      heldOwner(registered.projection, initial);
      assert.equal(registered.projection.runs[0]!.heldDroidSteer!.revision, newer);
      assert.deepEqual(
        registered.projection.runs.filter((run) => run.status === "queued"),
        fifo,
      );
      assert.deepEqual(
        registered.projection.messages.filter((message) =>
          fifoMessages.some((old) => old.id === message.id),
        ),
        fifoMessages,
      );
      h.hooks.afterReserve = undefined;
      h.hooks.beforeConsume = undefined;
      yield* gate.release;
      yield* trace.at("older-reservation-returned", Fiber.join(execution));
      yield* trace.at("newer-native-adoption", advance(h, initial, newer));
      assert.deepEqual(yield* h.wire, ["first", "cancel", "newer"]);
      assert.isFalse((yield* h.wire).includes("older"));
      yield* trace.drain("obsolete-effects-drain", 24, h.worker.drain(24));
      assert.isTrue(
        (yield* h.outbox.listByCommandId(older)).every((effect) => effect.status === "succeeded"),
      );
      for (const [index, run] of fifo.entries()) {
        yield* h.release("finish-prompt");
        yield* trace.at(
          `fifo-${index + 1}-predecessor-waiting`,
          h.waitFor(
            (p) =>
              p.runs.find(
                (candidate) =>
                  candidate.id === (index === 0 ? initial.runs[0]!.id : fifo[index - 1]!.id),
              )?.status === "waiting",
          ),
        );
        yield* trace.capture(`fifo-${index + 1}-before-drain`, { protocol: h.protocol });
        yield* trace.drain(`fifo-${index + 1}-drain`, 24, h.worker.drain(24));
        yield* trace.capture(`fifo-${index + 1}-after-drain`, { protocol: h.protocol });
        yield* trace.at(
          `fifo-${index + 1}-start-committed`,
          h.waitFor((p) =>
            p.runs.some(
              (candidate) =>
                candidate.id === run.id &&
                (candidate.status === "starting" || candidate.status === "running"),
            ),
          ),
        );
        yield* trace.drain(`fifo-${index + 1}-start-drain`, 24, h.worker.drain(24));
        yield* trace.at(
          `fifo-${index + 1}-native-decode`,
          h.waitDecoded(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "decoded" &&
              JSON.stringify(event.payload).includes(`native prompt: fifo-${index + 1}`),
          ),
        );
        const current = yield* h.orchestrator.getThreadProjection(h.threadId);
        const promoted = current.runs.find((candidate) => candidate.id === run.id)!;
        assert.equal(promoted.userMessageId, run.userMessageId);
        assert.deepEqual(promoted.modelSelection, run.modelSelection);
        assert.deepEqual(
          current.messages.find((message) => message.id === run.userMessageId),
          fifoMessages[index],
        );
      }
      assert.deepEqual(yield* h.wire, ["first", "cancel", "newer", "fifo-1", "fifo-2"]);
      yield* h.release("finish-prompt");
      yield* trace.at(
        "last-fifo-waiting",
        h.waitFor((p) => p.runs.find((run) => run.id === fifo[1]!.id)?.status === "waiting"),
      );
      yield* trace.drain("last-fifo-drain", 24, h.worker.drain(24));
      yield* trace.at(
        "all-fifo-runs-completed",
        h.waitFor((p) => p.runs.every((run) => run.status === "completed")),
      );
      yield* h.observe("newest-only-and-actual-FIFO-order", newer);
    }).pipe(Effect.onError((cause) => trace.failure(cause, { protocol: h.protocol })));
  }),
);

it.live.each(
  (["cancel-write", "cancel-settled"] as const).map((window) => ({
    caseTitle: `lets Stop invalidate a consumed Droid admission at ${window} without writing the replacement`,
    window,
  })),
)("$caseTitle", ({ window }) =>
  nativeCase(`stop-${window}`, "normal", (h) =>
    Effect.gen(function* () {
      const initial = yield* h.start();
      const command = yield* h.send("follow-up", initial.runs[0]!.id);
      yield* h.release("finish-run");
      yield* h.waitFor((p) =>
        p.turnItems.some(
          (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
        ),
      );
      const gate = yield* barrier();
      if (window === "cancel-write") h.hooks.cancel = gate.park;
      else h.hooks.afterCancel = gate.park;
      const execution = yield* h.worker.runOnce.pipe(Effect.forkScoped);
      yield* gate.entered;
      if (window === "cancel-settled")
        yield* h.waitFor((p) => p.providerTurns[0]?.status !== "running");
      const before = yield* h.observe("consumed-before-Stop", command);
      heldOwner(before.projection, initial);
      assert.equal(before.projection.runs[0]!.heldDroidSteer!.phase, "pre_admission");
      assert.isTrue((yield* h.native(initial)).droidSteerConsumed?.() ?? false);
      yield* h.stop(initial.runs[0]!.id);
      h.hooks.cancel = undefined;
      h.hooks.afterCancel = undefined;
      yield* gate.release;
      yield* Fiber.join(execution);
      yield* h.worker.drain(24);
      const final = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
      assert.lengthOf(final.attempts, 1);
      assert.isUndefined(final.runs[0]!.heldDroidSteer);
      assert.isFalse((yield* h.wire).includes("follow-up"));
      assert.isTrue(
        (yield* h.outbox.listByCommandId(command)).every((effect) => effect.status === "cancelled"),
      );
      yield* h.observe("consumed-Stop-is-single-terminal-owner", command);
    }),
  ),
);

it.live(
  "does not retry an actual native cancel after uncertain admission and lets Stop resolve the retained owner",
  () =>
    nativeCase("uncertain", "normal", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        h.hooks.failAfterCancel = true;
        yield* h.worker.drain(12);
        yield* h.waitFor((p) => p.providerTurns[0]?.status !== "running");
        const uncertain = yield* h.observe("actual-cancel-uncertain-no-replay", command);
        heldOwner(uncertain.projection, initial);
        assert.equal(uncertain.projection.runs[0]!.heldDroidSteer!.phase, "pre_admission");
        assert.isTrue(uncertain.commandEffects.some((effect) => effect.status === "failed"));
        assert.deepEqual(yield* h.wire, ["first", "cancel"]);
        yield* h.worker.drain(24);
        assert.deepEqual(yield* h.wire, ["first", "cancel"]);
        h.hooks.failAfterCancel = false;
        yield* h.stop(initial.runs[0]!.id);
        yield* h.worker.drain(24);
        const final = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
        assert.lengthOf(final.attempts, 1);
        assert.isUndefined(final.runs[0]!.heldDroidSteer);
        assert.isFalse((yield* h.wire).includes("follow-up"));
      }),
    ),
);

it.live(
  "rolls back SQL replacement after native consumption without replaying cancel or offering input",
  () =>
    nativeCase("sql-complete", "normal", (h) =>
      Effect.gen(function* () {
        const initial = yield* h.start();
        const command = yield* h.send("follow-up", initial.runs[0]!.id);
        yield* h.sql
          .unsafe(`CREATE TRIGGER reject_droid_complete BEFORE UPDATE ON orchestration_v2_projection_runs
      WHEN NEW.run_id = '${initial.runs[0]!.id}' AND json_extract(NEW.payload_json, '$.activeAttemptId') <> '${initial.runs[0]!.activeAttemptId}'
      BEGIN SELECT RAISE(ABORT, 'synthetic Droid replacement rejection'); END`);
        yield* h.release("finish-run");
        yield* h.waitFor((p) =>
          p.turnItems.some(
            (item) => item.nativeItemRef?.nativeId === "run" && item.status === "completed",
          ),
        );
        yield* h.worker.drain(12);
        yield* h.waitFor((p) => p.providerTurns[0]?.status !== "running");
        const rejected = yield* h.observe("SQL-replacement-rejected-after-native-consume", command);
        heldOwner(rejected.projection, initial);
        assert.equal(rejected.projection.runs[0]!.heldDroidSteer!.phase, "pre_admission");
        assert.deepEqual(yield* h.wire, ["first", "cancel"]);
        yield* h.worker.drain(12);
        assert.deepEqual(yield* h.wire, ["first", "cancel"]);
        yield* h.sql.unsafe("DROP TRIGGER reject_droid_complete");
        yield* h.stop(initial.runs[0]!.id);
        yield* h.worker.drain(24);
        const final = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
        assert.lengthOf(final.attempts, 1);
        assert.isUndefined(final.runs[0]!.heldDroidSteer);
        assert.isFalse((yield* h.wire).includes("follow-up"));
      }),
    ),
);
