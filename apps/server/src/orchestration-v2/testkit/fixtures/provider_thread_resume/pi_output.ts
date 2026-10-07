import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import {
  assertPiReplayConfirmedLaunches,
  piReplayExpectedSessionFile,
} from "../../../Adapters/PiReplaySessionBinding.testkit.ts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "../shared.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Pi's durable native thread id is its session file. After the idle release,
 * the respawned process must launch the same file and confirm its declared
 * UUID/file through get_state before prompting, and the resumed model still sees the first exchange.
 */
export function assertPiProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const processStarts = transcript.entries.filter(
    (entry) => entry.type === "expect_outbound" && field(entry.frame, "type") === "process_start",
  );
  assert.lengthOf(processStarts, 2, "the idle release must retire the first Pi process");
  const expectedFile = piReplayExpectedSessionFile(transcript, "/pi-sessions/session-1.jsonl");
  assertPiReplayConfirmedLaunches(transcript, "/pi-sessions/session-1.jsonl");

  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, expectedFile);
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.lengthOf(answers, 2);
  assert.include(answers[1], FIRST_FINAL, "the resumed session must remember the first answer");
  assert.include(answers[1], SECOND_FINAL);
}
