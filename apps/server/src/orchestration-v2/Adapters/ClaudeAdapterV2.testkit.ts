import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { claudeTaskOutputRoot } from "./ClaudeTaskOutputTail.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import {
  ClaudeAgentSdkReplayTranscript,
  type ClaudeQueryRunner,
  replayQueryRunnerError,
  nativeSessionIdFor,
  ClaudeOrchestratorReplayHarnessError,
  ClaudeReplayTranscriptDecodeError,
  metadataFromTranscript,
} from "./ClaudeAdapterV2.replay-protocol.testkit.ts";
import { makeReplayQueryRunner } from "./ClaudeAdapterV2.replay-query.testkit.ts";

const makeClaudeAgentSdkReplayQueryRunner = Effect.fn("ClaudeAgentSdkReplayQueryRunner.layer")(
  function* (
    transcript: ClaudeAgentSdkReplayTranscript,
    options: { readonly replayGate?: ProviderReplayGate } = {},
  ) {
    const queryRunner = makeReplayQueryRunner(transcript, options);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        queryRunner.assertComplete();
      }),
    );

    return replayQueryRunnerService(transcript, queryRunner);
  },
);

function replayQueryRunnerService(
  transcript: ClaudeAgentSdkReplayTranscript,
  queryRunner: ClaudeQueryRunner,
): ClaudeAdapterV2.ClaudeAgentSdkQueryRunner["Service"] {
  const replay = <A>(run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) => replayQueryRunnerError(transcript, cause),
    });
  return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
    allocateSessionId: Effect.succeed(nativeSessionIdFor(transcript)),
    open: (input) => replay(() => queryRunner.open(input)),
    forkSession: (input) => replay(() => queryRunner.forkSession(input)),
    subagentLaunchToolUseId: (input) => replay(() => queryRunner.subagentLaunchToolUseId(input)),
    assertComplete: replay(() => queryRunner.assertComplete()),
  });
}

function layerClaudeAgentSdkReplayQueryRunner(
  transcript: ClaudeAgentSdkReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
): Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner> {
  return Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    makeClaudeAgentSdkReplayQueryRunner(transcript, options),
  );
}

function layerClaudeAgentSdkReplay(
  transcript: ClaudeAgentSdkReplayTranscript,
  options: {
    readonly replayGate?: ProviderReplayGate;
    readonly queryRunner?: ClaudeQueryRunner;
  } = {},
): Layer.Layer<ClaudeAdapterV2.ClaudeAgentSdkQueryRunner> {
  if (options.queryRunner !== undefined) {
    return Layer.succeed(
      ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
      replayQueryRunnerService(transcript, options.queryRunner),
    );
  }
  const queryRunner = makeReplayQueryRunner(transcript, options);
  return Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          queryRunner.assertComplete();
        }),
      );
      return replayQueryRunnerService(transcript, queryRunner);
    }),
  );
}

/**
 * While a foreground Bash call runs, Claude Code writes its output to a task
 * file the adapter tails. A replay has no Claude Code process, so it writes the
 * file each recorded `task_started` names, holding that call's recorded output,
 * under a scenario-owned `CLAUDE_CODE_TMPDIR`.
 */
const writeReplayTaskOutputFiles = Effect.fn("ClaudeReplay.writeTaskOutputFiles")(function* (
  transcript: ClaudeAgentSdkReplayTranscript,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-replay-tasks-" });
  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && typeof entry.frame === "object" && entry.frame !== null
      ? [entry.frame as Record<string, unknown>]
      : [],
  );
  const outputByToolUseId = new Map<string, string>();
  for (const frame of frames) {
    const result = frame.tool_use_result as Record<string, unknown> | undefined;
    const content = (frame.message as { readonly content?: unknown } | undefined)?.content;
    if (typeof result?.stdout !== "string" || !Array.isArray(content)) continue;
    const toolResult = content.find(
      (block): block is { readonly tool_use_id: string } =>
        block?.type === "tool_result" && typeof block.tool_use_id === "string",
    );
    if (toolResult === undefined) continue;
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    outputByToolUseId.set(toolResult.tool_use_id, `${result.stdout}${stderr}`);
  }
  const root = claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: tmpRoot }, path);
  for (const frame of frames) {
    if (frame.type !== "system" || frame.subtype !== "task_started") continue;
    if (frame.task_type !== "local_bash" || frame.is_backgrounded !== false) continue;
    const output =
      typeof frame.tool_use_id === "string" ? outputByToolUseId.get(frame.tool_use_id) : undefined;
    if (root === undefined || output === undefined || typeof frame.session_id !== "string") {
      continue;
    }
    const tasks = path.join(root, "replay-project", frame.session_id, "tasks");
    yield* fileSystem.makeDirectory(tasks, { recursive: true });
    yield* fileSystem.writeFileString(path.join(tasks, `${String(frame.task_id)}.output`), output);
  }
  return tmpRoot;
});

function layerClaudeProviderAdapterRegistryReplay(
  transcript: ClaudeAgentSdkReplayTranscript,
  options: {
    readonly replayGate?: ProviderReplayGate;
    readonly queryRunner?: ClaudeQueryRunner;
  } = {},
) {
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.unwrap(
    writeReplayTaskOutputFiles(transcript).pipe(
      Effect.orDie,
      Effect.map((tmpRoot) =>
        ProviderAdapterRegistry.layerFromDrivers({
          drivers: [ClaudeAdapterV2.ClaudeAdapterV2Driver],
          configMap: {
            [ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID]: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              environment: [{ name: "CLAUDE_CODE_TMPDIR", value: tmpRoot, sensitive: false }],
            },
          },
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerClaudeAgentSdkReplay(transcript, options),
        IdAllocator.layer,
        NodeServices.layer,
        layerServerConfig,
      ),
    ),
  );
}

const decodeClaudeAgentSdkReplayTranscript = Schema.decodeUnknownEffect(
  ClaudeAgentSdkReplayTranscript,
);

export const ClaudeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ClaudeAgentSdkReplayTranscript,
  ClaudeOrchestratorReplayHarnessError
> = {
  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeClaudeAgentSdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    layerClaudeProviderAdapterRegistryReplay(transcript, options),
};

export function makeClaudeRestartReplayHarness(transcript: ClaudeAgentSdkReplayTranscript) {
  const queryRunner = makeReplayQueryRunner(transcript);
  return {
    harness: {
      ...ClaudeOrchestratorReplayHarness,
      makeProviderAdapterRegistryLayer: (replayed) =>
        layerClaudeProviderAdapterRegistryReplay(replayed, { queryRunner }),
    } satisfies typeof ClaudeOrchestratorReplayHarness,
    assertComplete: replayQueryRunnerService(transcript, queryRunner).assertComplete,
  };
}
export {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  claudeBackgroundWakeResultLabel,
  ClaudeReplayTranscriptDecodeError,
  ClaudeReplayExhaustedError,
  ClaudeReplayUnexpectedOutboundError,
  ClaudeReplayFrameMismatchError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayIncompleteError,
  ClaudeReplayDriverError,
  ClaudeAgentSdkReplayError,
  ClaudeOrchestratorReplayHarnessError,
} from "./ClaudeAdapterV2.replay-protocol.testkit.ts";

export { recordClaudeAgentSdkReplayTranscript } from "./ClaudeAdapterV2.recording.testkit.ts";
