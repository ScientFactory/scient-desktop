import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import type { ProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";
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
    // Shared across runtimes; its owner asserts completion.
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
  return ProviderAdapterRegistry.layerFromDrivers({
    drivers: [ClaudeAdapterV2.ClaudeAdapterV2Driver],
    configMap: {
      [ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID]: {
        driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
      },
    },
  }).pipe(
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

/**
 * Replays one transcript across several orchestrator runtimes, the way a
 * server restart reopens the same native session with a fresh adapter.
 */
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
