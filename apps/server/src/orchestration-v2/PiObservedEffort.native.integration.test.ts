/** Controlled native Pi JSONL peer; real adapter, manager, worker and file-backed V2 SQL. */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import { makePiAdapterV2 } from "./Adapters/PiAdapterV2.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdaptersEffect as makeLayerEffect } from "./ProviderAdapterRegistry.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWire = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);
const outer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const known = {
  status: "known",
  source: "provider",
  checkedAt: "2026-10-05T00:00:00Z",
  stale: false,
  supported: true,
  levels: ["off", "high"],
  defaultLevel: "high",
};
const unknown = { ...known, status: "unknown", source: "unknown", supported: null, levels: [] };

const nativeScenario = (
  name: string,
  initialLevel: "off" | "high",
  metadata: typeof known | typeof unknown | undefined,
  selectionOptions?: ModelSelection["options"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* checkpointWorkspace(`pi-observed-${name}`, {
      "fixture.txt": "Synthetic Pi observation\n",
    });
    const profile = yield* fs.makeTempDirectoryScoped({ prefix: "pi-observed-profile-" });
    const control = `${profile}/control.json`;
    const wire = `${profile}/wire.jsonl`;
    const script = `${profile}/peer.cjs`;
    const binary = `${profile}/pi-peer.sh`;
    const instanceId = ProviderInstanceId.make(`pi-observed-${name}`);
    const threadId = ThreadId.make(`pi-observed-${name}`);
    const projectId = ProjectId.make(`pi-observed-${name}`);
    const selection: ModelSelection = {
      instanceId,
      model:
        name === "fresh-default" ||
        name === "fresh-high" ||
        name === "unknown-next" ||
        name.startsWith("foreign") ||
        name === "unavailable" ||
        name === "adopted"
          ? "default"
          : "fixture/model",
      ...(selectionOptions === undefined ? {} : { options: selectionOptions }),
    };
    // The peer re-reads control every 20 ms; an in-place rewrite exposes a truncated
    // file whose JSON.parse crashes it. Publish each state with an atomic rename.
    const writeControl = (state: unknown) =>
      fs
        .writeFileString(`${control}.next`, json(state))
        .pipe(Effect.andThen(fs.rename(`${control}.next`, control)));
    yield* writeControl({
      metadata,
      thinkingLevel: initialLevel,
      ...(name === "unavailable" ? { overrideLevel: "invalid-native-level" } : {}),
    });
    yield* fs.writeFileString(wire, "");
    yield* fs.writeFileString(
      script,
      `const fs=require('node:fs'),rl=require('node:readline');
const args=process.argv.slice(2),file=args[args.indexOf('--session')+1],sessionId='00000000-0000-4000-8000-000000000598';
if(!file)throw Error('Missing private session path');
if(!fs.existsSync(file)||!fs.readFileSync(file,'utf8').trim())fs.writeFileSync(file,JSON.stringify({type:'session',id:sessionId})+'\\n');
let level=${json(initialLevel)},count=0;
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const state=()=>{const c=JSON.parse(fs.readFileSync(process.env.PI_EFFORT_CONTROL,'utf8'));return {sessionFile:c.foreign?file+'.foreign':file,sessionId,model:{provider:'fixture',id:'model',contextWindow:32000,input:['text'],...(c.metadata?{reasoningMetadata:c.metadata}:{})},thinkingLevel:c.overrideLevel??level,isStreaming:false,isCompacting:false,messageCount:count,pendingMessageCount:0};};
let offeredWork=false;
setInterval(()=>{const c=JSON.parse(fs.readFileSync(process.env.PI_EFFORT_CONTROL,'utf8'));if(c.nativeWork&&!offeredWork){offeredWork=true;emit({type:'agent_start'});const message={role:'assistant',content:[{type:'text',text:'Original native extension generation'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2}};emit({type:'message_start',message});emit({type:'message_end',message});emit({type:'agent_end',messages:[message],willRetry:false});emit({type:'agent_settled'});}},20);
rl.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(process.env.PI_EFFORT_WIRE,JSON.stringify(r)+'\\n');let data={};
if(r.type==='get_state')data=state();
if(r.type==='get_available_models')data={models:[state().model]};
if(r.type==='get_commands')data={commands:[]};
if(r.type==='set_model')data=state().model;
if(r.type==='get_available_thinking_levels')data={levels:['off','high']};
if(r.type==='set_thinking_level')level=r.level;
if(r.type==='get_session_stats')data={sessionId,sessionFile:file,toolCalls:0,tokens:{input:1,output:1,cacheRead:0,cacheWrite:0,total:2}};
if(r.type==='get_entries')data={entries:[]};
if(r.type==='get_messages')data={messages:[]};
if(r.type==='prompt'){count++;emit({type:'response',command:'prompt',success:true});emit({type:'agent_start'});const message={role:'assistant',content:[{type:'text',text:'Native synthetic answer '+count}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2}};emit({type:'message_start',message});emit({type:'message_end',message});emit({type:'agent_end',messages:[message],willRetry:false});emit({type:'agent_settled'});return;}
if(r.id)emit({type:'response',id:r.id,command:r.type,success:true,data});
});`,
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    yield* fs.writeFileString(
      binary,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    );
    yield* fs.chmod(binary, 0o755);
    const config = yield* makeReplayServerConfig(`pi-observed-${name}`);
    yield* Effect.addFinalizer(() =>
      fs.remove(config.baseDir, { recursive: true }).pipe(Effect.orDie),
    );
    const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
    const database = makeSqlitePersistenceLive(`${profile}/state.sqlite`).pipe(
      Layer.provide(outer),
    );
    const registry = makeLayerEffect(
      Effect.gen(function* () {
        return [
          makePiAdapterV2({
            instanceId,
            settings: { enabled: true, binaryPath: binary, launchArgs: "", customModels: [] },
            environment: {
              HOME: profile,
              PATH: process.env.PATH,
              PI_EFFORT_CONTROL: control,
              PI_EFFORT_WIRE: wire,
            },
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            fileSystem: fs,
            serverConfig: config,
            continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
          }),
        ];
      }).pipe(Effect.provide(outer)),
    );
    const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
      // The replay policy ignores project roots; without this cwd the run (and its
      // checkpoint capture) falls back to process.cwd(), the host repository.
      { name: `pi-observed-${name}`, runtimePolicyOverride: { cwd } },
      registry,
      { layerDatabase: database, layerServerConfig: configLayer, runContinuationWorker: true },
    );
    const result = yield* Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make(`pi-observed-project-${name}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Synthetic Pi",
          workspaceRoot: cwd,
          defaultModelSelection: selection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`pi-observed-create-${name}`),
        threadId,
        projectId,
        title: "Synthetic Pi",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
        Effect.scoped(
          Effect.gen(function* () {
            const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({ threadId, afterSequence }),
            );
            const first = yield* orchestrator.getThreadProjection(threadId);
            const found = yield* Stream.concat(
              Stream.succeed(first),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
              ),
            ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
            return yield* Option.match(found, {
              onNone: () => Effect.die("No decisive projection"),
              onSome: Effect.succeed,
            });
          }),
        );
      const send = (n: number) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`pi-observed-send-${name}-${n}`),
          messageId: MessageId.make(`pi-observed-message-${name}-${n}`),
          threadId,
          text: `Synthetic observation ${n}`,
          dispatchMode: { type: "start_immediately" },
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        });
      yield* send(1);
      const firstCompleted = yield* waitFor((p) => p.runs[0]?.status === "completed");
      let completed = firstCompleted;
      if (name === "unknown-next") {
        yield* writeControl({ metadata: unknown, overrideLevel: "high" });
        yield* send(2);
        completed = yield* waitFor(
          (p) => p.runs.length === 2 && p.runs.every((r) => r.status === "completed"),
        );
      }
      if (name.startsWith("foreign")) {
        yield* writeControl({
          metadata: known,
          foreign: true,
          overrideLevel: name === "foreign-invalid" ? "invalid-native-level" : "high",
        });
        yield* send(2);
        completed = yield* waitFor(
          (p) => p.runs.length === 2 && p.runs.some((r) => r.status === "failed"),
        );
      }
      if (name === "adopted") {
        yield* writeControl({ metadata: known, overrideLevel: "high", nativeWork: true });
        completed = yield* waitFor(
          (p) => p.runs.length === 2 && p.runs.every((r) => r.status === "completed"),
        );
      }
      const store = yield* EventStore.EventStoreV2;
      const stored = yield* Stream.runCollect(store.read({ threadId }));
      const receipts = stored.map((e) => e.event).filter((e) => e.type === "provider-turn.updated");
      return { completed, firstCompleted, receipts };
    }).pipe(Effect.scoped, Effect.provide(runtime));
    const reopened = yield* Effect.gen(function* () {
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* projection.getThreadProjection(threadId);
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      assert.isTrue((yield* maintenance.rebuild).valid);
      const after = yield* projection.getThreadProjection(threadId);
      assert.deepEqual(after.providerTurns, before.providerTurns);
      return after;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ProjectionMaintenance.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
              Layer.provideMerge(
                makeSqlitePersistenceLive(`${profile}/state.sqlite`).pipe(Layer.provide(outer)),
              ),
            ),
          ),
        ),
      ),
    );
    const requests = (yield* fs.readFileString(wire))
      .trim()
      .split("\n")
      .map((line) => decodeWire(line));
    return { ...result, reopened, requests };
  });

it.live(
  "persists actual untouched native default effort through terminal, fresh SQL reopen and rebuild",
  () =>
    nativeScenario("fresh-default", "off", known).pipe(
      Effect.map(({ completed, reopened, receipts, requests }) => {
        assert.propertyVal(completed.providerTurns[0], "observedEffort", "off");
        assert.propertyVal(reopened.providerTurns[0], "observedEffort", "off");
        assert.isTrue(receipts.some((e) => e.payload.status === "running"));
        assert.equal(
          receipts.find((e) => e.payload.status === "running")?.payload.observedEffort,
          "off",
        );
        assert.isFalse(
          requests.some((r) => r.type === "set_model" || r.type === "set_thinking_level"),
        );
        assert.equal(completed.providerTurns[0]?.nativeAcceptance, "accepted");
        assert.equal(completed.runs.length, 1);
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);

it.live.each(
  (
    [
      ["fresh-high", "high", undefined, "high"],
      ["inherited-off", "off", undefined, "off"],
      ["explicit-default", "off", [{ id: "thinkingLevel", value: "default" }], "high"],
      ["explicit-off", "high", [{ id: "thinkingLevel", value: "off" }], "off"],
      ["explicit-high", "off", [{ id: "thinkingLevel", value: "high" }], "high"],
    ] as const
  ).map(([name, initial, options, expected]) => ({
    caseTitle: `records correlated ${name} native effort without inventing policy or acceptance`,
    name,
    initial,
    options,
    expected,
  })),
)(
  "$caseTitle",
  ({ name, initial, options, expected }) =>
    nativeScenario(name, initial, known, options).pipe(
      Effect.map(({ completed, reopened, requests }) => {
        assert.equal(completed.providerTurns[0]?.observedEffort, expected);
        assert.equal(reopened.providerTurns[0]?.observedEffort, expected);
        assert.equal(completed.providerTurns[0]?.nativeAcceptance, "accepted");
        assert.equal(
          completed.runs[0]?.modelSelection?.model,
          name === "fresh-high" ? "default" : "fixture/model",
        );
        assert.lengthOf(
          requests.filter((r) => r.type === "prompt"),
          1,
        );
        if (name === "fresh-high")
          assert.isFalse(
            requests.some((r) => r.type === "set_model" || r.type === "set_thinking_level"),
          );
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);
it.live(
  "unknown native reasoning metadata does not expose a requested high value",
  () =>
    nativeScenario("unknown-explicit", "off", unknown, [
      { id: "thinkingLevel", value: "high" },
    ]).pipe(
      Effect.map(({ completed, reopened }) => {
        assert.notProperty(completed.providerTurns[0], "observedEffort");
        assert.notProperty(reopened.providerTurns[0], "observedEffort");
        assert.equal(completed.providerTurns[0]?.nativeAcceptance, "accepted");
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);
it.live(
  "a new unknown turn never inherits the preceding known off snapshot",
  () =>
    nativeScenario("unknown-next", "off", known).pipe(
      Effect.map(({ firstCompleted, completed, reopened }) => {
        assert.equal(firstCompleted.providerTurns[0]?.observedEffort, "off");
        assert.lengthOf(completed.providerTurns, 2);
        assert.notEqual(completed.providerTurns[0]?.id, completed.providerTurns[1]?.id);
        assert.equal(completed.providerTurns[0]?.observedEffort, "off");
        assert.notProperty(completed.providerTurns[1], "observedEffort");
        assert.notProperty(reopened.providerTurns[1], "observedEffort");
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);
it.live.each(
  ["foreign", "foreign-invalid"].map((name) => ({
    caseTitle: `${name} native state refuses the new root before prompt and cannot replace prior observation`,
    name,
  })),
)(
  "$caseTitle",
  ({ name }) =>
    nativeScenario(name, "off", known).pipe(
      Effect.map(({ completed, reopened, requests }) => {
        assert.lengthOf(completed.runs, 2);
        assert.isTrue(completed.runs.some((r) => r.status === "failed"));
        assert.lengthOf(
          requests.filter((r) => r.type === "prompt"),
          1,
        );
        assert.lengthOf(completed.providerTurns, 1);
        assert.equal(reopened.providerTurns[0]?.observedEffort, "off");
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);
it.live(
  "adopted native work omits later state rather than misattributing the original generation",
  () =>
    nativeScenario("adopted", "off", known).pipe(
      Effect.map(({ completed, reopened, requests }) => {
        assert.lengthOf(completed.runs, 2);
        assert.isTrue(
          completed.messages.some((m) => m.notification?.source.kind === "provider_work"),
        );
        assert.lengthOf(
          requests.filter((r) => r.type === "prompt"),
          1,
        );
        assert.equal(completed.providerTurns[0]?.observedEffort, "off");
        assert.notProperty(completed.providerTurns[1], "observedEffort");
        assert.notProperty(reopened.providerTurns[1], "observedEffort");
        assert.equal(completed.providerTurns[1]?.nativeAcceptance, "accepted");
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);

it.live(
  "unavailable optional native effort stays unknown without changing the native default",
  () =>
    nativeScenario("unavailable", "off", known).pipe(
      Effect.map(({ completed, reopened, requests }) => {
        assert.notProperty(completed.providerTurns[0], "observedEffort");
        assert.notProperty(reopened.providerTurns[0], "observedEffort");
        assert.equal(completed.providerTurns[0]?.nativeAcceptance, "accepted");
        assert.isFalse(
          requests.some((r) => r.type === "set_model" || r.type === "set_thinking_level"),
        );
        assert.lengthOf(
          requests.filter((r) => r.type === "prompt"),
          1,
        );
      }),
      Effect.scoped,
      Effect.provide(outer),
    ),
  30000,
);
