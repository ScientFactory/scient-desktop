import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  materializeOpenCodeReplayPermissions,
  OpenCodeOrchestratorReplayHarness,
} from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { readProviderReplayTranscript } from "./ReplayTranscriptNdjson.ts";

describe("replay scenario failure lifetime", () => {
  it.live(
    "fails the required approval step after a real strict replay mismatch without waiting for an impossible request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
            (candidate) => candidate.name === "opencode_child_approval",
          );
          assert.isDefined(fixture);
          const provider = fixture.providers[0];
          assert.isDefined(provider);
          const recorded = yield* readProviderReplayTranscript(provider.transcriptFile).pipe(
            Effect.provide(NodeServices.layer),
          );
          const fixtureInput = fixture.buildInput();
          const workspace = yield* checkpointWorkspace("required-approval-after-strict-mismatch");
          const runtimePolicy = {
            ...provider.runtimePolicyOverride,
            cwd: provider.runtimePolicyOverride?.cwd ?? workspace,
            runtimeMode: fixtureInput.runtimeMode ?? "full-access",
            interactionMode: fixtureInput.interactionMode ?? "default",
          } satisfies ProviderAdapterV2RuntimePolicy;
          const prepared = materializeOpenCodeReplayPermissions(recorded, runtimePolicy);
          const promptIndex = prepared.entries.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "session.promptAsync",
          );
          assert.isAtLeast(promptIndex, 0);
          const transcript = yield* OpenCodeOrchestratorReplayHarness.decodeTranscript({
            ...prepared,
            scenario: "required-approval-after-strict-mismatch",
            entries: prepared.entries
              .slice(0, promptIndex + 1)
              .map((entry, index) =>
                index === promptIndex && entry.type === "expect_outbound"
                  ? { ...entry, frame: { type: "deliberate.strict.frame.mismatch" } }
                  : entry,
              ),
          });
          const materialized = yield* materializeFixtureInput({
            scenario: transcript.scenario,
            fixtureInput,
            driver: provider.driver,
            modelSelection: provider.modelSelection,
          }).pipe(Effect.provide(IdAllocator.layer));
          const result = yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: transcript.scenario,
              transcript,
              commands: materialized.commands,
              steps: materialized.steps,
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: runtimePolicy,
            },
            OpenCodeOrchestratorReplayHarness,
          ).pipe(provideDeterministicTestRuntime, Effect.timeout("5 seconds"), Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isSuccess(result)) return;
          const failure = Cause.pretty(result.cause);
          assert.include(failure, "OpenCodeReplayMismatchError");
          assert.include(failure, "terminal_without_request");
          assert.include(failure, ":failed");
          assert.notInclude(failure, "TimeoutError");
        }),
      ),
  );
});
