import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderReplayTranscript,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { toMcpCapabilities } from "../../mcp/McpInvocationContext.ts";
import { buildScientRuntimeInstructions } from "../../provider/ScientRuntimeInstructions.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { scientToolProjectionForProvider } from "../../provider/ScientToolProjection.ts";
import { prepareScientSkillTurn } from "../../scient/skills/ScientSkillInvocation.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

export class CodexReplayTranscriptDecodeError extends Schema.TaggedError<CodexReplayTranscriptDecodeError>()(
  "CodexReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Codex app-server replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export const CodexOrchestratorReplayHarnessError = Schema.Union([
  CodexReplayTranscriptDecodeError,
  CodexReplay.CodexAppServerReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CodexOrchestratorReplayHarnessError = typeof CodexOrchestratorReplayHarnessError.Type;

export function withCodexReplayChildMetadata(
  client: CodexClient.CodexAppServerClient["Service"],
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  readMetadata: (
    threadId: string,
    method: "thread/read" | "thread/resume",
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError> = (threadId) =>
    Effect.succeed({ thread: { id: threadId }, model: null }),
): CodexClient.CodexAppServerClient["Service"] {
  const childThreadIds = new Set(
    transcript.entries.flatMap((entry) => {
      if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) return [];
      const params = entry.frame.params;
      if (!Predicate.isObject(params) || !Predicate.isObject(params.item)) return [];
      const item = params.item;
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
        return [item.agentThreadId];
      }
      return item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter(Predicate.isString)
        : [];
    }),
  );
  return {
    ...client,
    raw: {
      ...client.raw,
      request: (method, params) =>
        (method === "thread/read" || method === "thread/resume") &&
        Predicate.isObject(params) &&
        (method === "thread/read" ? params.includeTurns === false : params.excludeTurns === true) &&
        typeof params.threadId === "string" &&
        childThreadIds.has(params.threadId)
          ? readMetadata(params.threadId, method)
          : client.raw.request(method, params),
    },
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export function makeReplayServerConfig(
  scenario: string,
): Effect.Effect<
  ServerConfig.ServerConfig["Service"],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectory({
      prefix: `t3-orchestration-v2-codex-${scenario}-`,
    });
    const stateDir = path.join(baseDir, "userdata");
    const logsDir = path.join(stateDir, "logs");
    const providerLogsDir = path.join(logsDir, "provider");
    const terminalLogsDir = path.join(logsDir, "terminals");
    const attachmentsDir = path.join(stateDir, "attachments");
    const environmentThemesDir = path.join(stateDir, "themes");
    const worktreesDir = path.join(baseDir, "worktrees");
    const providerStatusCacheDir = path.join(baseDir, "caches");

    for (const directory of [
      stateDir,
      logsDir,
      providerLogsDir,
      terminalLogsDir,
      attachmentsDir,
      environmentThemesDir,
      worktreesDir,
      providerStatusCacheDir,
    ]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }

    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: false,
      startupPresentation: "browser",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      stateDir,
      dbPath: path.join(stateDir, "state.sqlite"),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      settingsPath: path.join(stateDir, "settings.json"),
      providerStatusCacheDir,
      worktreesDir,
      attachmentsDir,
      browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
      analysisDir: path.join(stateDir, "analysis"),
      computeDir: path.join(stateDir, "compute"),
      latexDir: path.join(stateDir, "latex"),
      documentArtifactsDir: path.join(stateDir, "document-artifacts"),
      environmentThemesDir,
      logsDir,
      serverLogPath: path.join(logsDir, "server.log"),
      serverTracePath: path.join(logsDir, "server.trace.ndjson"),
      providerLogsDir,
      providerEventLogPath: path.join(providerLogsDir, "events.log"),
      terminalLogsDir,
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
      environmentIdPath: path.join(stateDir, "environment-id"),
      serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
      secretsDir: path.join(stateDir, "secrets"),
    };
  });
}

export function layer(input: {
  readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
  readonly driver?: CodexReplay.CodexAppServerReplayDriver;
  readonly instanceIds?: ReadonlyArray<ProviderInstanceId>;
}) {
  const layerReplay =
    input.driver === undefined
      ? CodexReplay.layerReplay(input.transcript)
      : CodexReplay.layerReplayWithDriver(input.driver);
  const layerReplayClientFactory = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
    open: (openInput) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(layerReplay).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        );
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.map((client) => withCodexReplayChildMetadata(client, input.transcript)),
          Effect.provide(context),
        );
      }),
  });
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(input.transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerRegistry = ProviderAdapterRegistry.layerFromDrivers({
    drivers: [CodexAdapterV2.CodexAdapterV2Driver],
    configMap: Object.fromEntries(
      (input.instanceIds ?? [CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID]).map((instanceId) => [
        instanceId,
        { driver: CodexAdapterV2.CODEX_DRIVER_KIND },
      ]),
    ),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerReplayClientFactory,
        layerServerConfig,
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  return layerRegistry;
}

const decodeCodexAppServerReplayTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);

/** Adapt recorded request expectations for Scient identity and always-on core guidance.
 * Native response/event frames and the structural matcher remain unchanged.
 */
export function materializeScientClientIdentity(transcript: ProviderReplayTranscript) {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound" || !Predicate.isObject(entry.frame)) return entry;
      const frame = entry.frame;
      if (
        frame.method === "turn/start" &&
        Predicate.isObject(frame.params) &&
        frame.params.additionalContext === undefined
      ) {
        return {
          ...entry,
          frame: {
            ...frame,
            params: {
              ...frame.params,
              additionalContext: {
                t3_code_runtime: {
                  kind: "application",
                  value: buildScientRuntimeInstructions({
                    harness: "Codex",
                    model: typeof frame.params.model === "string" ? frame.params.model : "gpt-5.4",
                    reasoningEffort:
                      typeof frame.params.effort === "string" ? frame.params.effort : "medium",
                  }),
                },
                scient_awareness: { kind: "application", value: buildScientAwareness() },
              },
            },
          },
        };
      }
      if (frame.method !== "initialize" || !Predicate.isObject(frame.params)) return entry;
      const params = frame.params;
      if (!Predicate.isObject(params.clientInfo)) return entry;
      const clientInfo = params.clientInfo;
      if (clientInfo.name !== "T3 Code" || clientInfo.title !== "T3 Code") return entry;
      return {
        ...entry,
        frame: {
          ...frame,
          params: {
            ...params,
            clientInfo: { ...clientInfo, name: "t3code_desktop", title: "Scient Desktop" },
          },
        },
      };
    }),
  };
}

const makeCodexReplayRegistryLayer = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  options: {
    readonly replayGate?: ProviderReplayGate;
    readonly materializeExpectedOutbound?: CodexReplay.CodexAppServerReplayDriver["materializeExpectedOutbound"];
  } = {},
) => {
  return Layer.effectContext(
    Effect.gen(function* () {
      const replayGate = options.replayGate;
      if (replayGate !== undefined) {
        yield* Effect.addFinalizer(() => Effect.sync(() => replayGate.releaseAll()));
      }
      const driver = yield* CodexReplay.makeReplayDriver(transcript, {
        ...(options.materializeExpectedOutbound === undefined
          ? {}
          : { materializeExpectedOutbound: options.materializeExpectedOutbound }),
        ...(replayGate === undefined
          ? {}
          : {
              beforeEmitInbound: (entry) =>
                Effect.promise((signal) => replayGate.beforeEmit(entry.label, signal)),
            }),
      });
      return yield* Layer.build(layer({ transcript, driver }));
    }),
  );
};

export const CodexOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CodexReplay.CodexAppServerReplayTranscript,
  CodexOrchestratorReplayHarnessError
> = {
  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
  decodeTranscript: (transcript) =>
    decodeCodexAppServerReplayTranscript(materializeScientClientIdentity(transcript)).pipe(
      Effect.mapError(
        (cause) =>
          new CodexReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: makeCodexReplayRegistryLayer,
};

export interface IssuedCodexReplayScope {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  /** Whether this fixture's real skill planner delivers an empty catalog marker. */
  readonly includeEmptySkillCatalogMarker?: boolean;
}

const decodeReplayCodexInput = Schema.decodeUnknownEffect(
  Schema.Array(CodexSchema.V2TurnStartParams__UserInput),
);

/** Project a fixture-declared complete empty skill scope, independently of outbound frames. */
export function emptyMcpReplayPrompt(driver: ProviderDriverKind, text: string): string {
  const tools = scientToolProjectionForProvider(driver);
  return (
    prepareScientSkillTurn(
      text,
      [],
      new Map(),
      {
        includeCatalogMarker: true,
        skillListToolName: tools.name("scient_skills_list"),
        skillLoadToolName: tools.name("scient_skill_load"),
        providerNativeSkillTool: tools.providerNativeSkillTool,
        deferred: tools.deferred,
      },
      [],
      "complete",
    ).input ?? text
  );
}

/** Resolve only fixture-mapped issued scopes; never derive expectations from outbound requests. */
export function withIssuedCodexMcpReplayExpectations(
  scopeForLabel: (label: string) => IssuedCodexReplayScope | undefined,
): typeof CodexOrchestratorReplayHarness {
  return {
    ...CodexOrchestratorReplayHarness,
    makeProviderAdapterRegistryLayer: (transcript, options) =>
      makeCodexReplayRegistryLayer(transcript, {
        ...options,
        materializeExpectedOutbound: (entry) =>
          Effect.gen(function* () {
            const frame = entry.frame;
            if (
              !Predicate.isObject(frame) ||
              !Predicate.isObject(frame.params) ||
              typeof frame.method !== "string" ||
              !["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(frame.method)
            )
              return frame;
            const scope = entry.label === undefined ? undefined : scopeForLabel(entry.label);
            if (scope === undefined)
              return yield* Effect.die(
                "Native MCP replay request has no fixture-owned scope mapping.",
              );
            const issued = McpProviderSession.readMcpProviderSession(scope.threadId);
            if (
              issued === undefined ||
              issued.providerInstanceId !== scope.instanceId ||
              scope.modelSelection.instanceId !== scope.instanceId
            ) {
              return yield* Effect.die(
                "Native MCP replay scope has no matching issued instance credential.",
              );
            }
            const params = frame.params;
            if (frame.method !== "turn/start") {
              const native = CodexAdapterV2.codexThreadRuntimeParams({
                configureMcp: true,
                threadId: scope.threadId,
                modelSelection: scope.modelSelection,
                runtimePolicy: scope.runtimePolicy,
              });
              return {
                ...frame,
                params: {
                  ...native,
                  ...params,
                  config: {
                    ...(Predicate.isObject(params.config) ? params.config : {}),
                    ...native.config,
                  },
                },
              };
            }
            if (typeof params.threadId !== "string")
              return yield* Effect.die("Native MCP replay turn has no recorded native thread id.");
            const recordedInput = yield* decodeReplayCodexInput(params.input).pipe(Effect.orDie);
            const codexInput = recordedInput.map((item) =>
              item.type === "text" && scope.includeEmptySkillCatalogMarker === true
                ? {
                    ...item,
                    text: emptyMcpReplayPrompt(CodexAdapterV2.CODEX_DRIVER_KIND, item.text),
                  }
                : item,
            );
            const native = yield* CodexAdapterV2.buildCodexTurnStartParams({
              nativeThreadId: params.threadId,
              codexInput,
              runtimePolicy: scope.runtimePolicy,
              modelSelection: scope.modelSelection,
              hasT3Mcp: true,
              mcpCapabilities: toMcpCapabilities(issued.capabilities),
            }).pipe(Effect.orDie);
            return {
              ...frame,
              params: {
                ...native,
                ...params,
                input: codexInput,
                additionalContext: native.additionalContext,
                collaborationMode: native.collaborationMode,
              },
            };
          }),
      }),
  };
}
