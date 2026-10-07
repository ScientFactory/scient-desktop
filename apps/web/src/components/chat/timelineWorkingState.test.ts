import { MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";
import { hasServerAcknowledgedLocalDispatch, type LocalDispatchSnapshot } from "../ChatView.logic";
import { derivePhase } from "../../session-logic";
import { resolveTimelineWorking } from "./timelineWorkingState";

const previousPrompt = MessageId.make("prompt-1");
const sentPrompt = MessageId.make("prompt-2");
const sendingAlone = {
  isWorking: true,
  onlySendBusy: true,
  dispatchBaselineUserMessageId: previousPrompt,
  promptRunStarting: false,
};

describe("resolveTimelineWorking", () => {
  it("holds the working row back until the sent prompt is in the list", () => {
    expect(
      resolveTimelineWorking({
        ...sendingAlone,
        latestUserMessageId: previousPrompt,
        optimisticPromptShown: false,
      }),
    ).toBe(false);
    // The optimistic row, or the server's newer user message, places it.
    expect(
      resolveTimelineWorking({
        ...sendingAlone,
        latestUserMessageId: previousPrompt,
        optimisticPromptShown: true,
      }),
    ).toBe(true);
    expect(
      resolveTimelineWorking({
        ...sendingAlone,
        latestUserMessageId: sentPrompt,
        optimisticPromptShown: false,
      }),
    ).toBe(true);
  });

  it("shows other work at once, and nothing when the thread is not working", () => {
    const promptMissing = { latestUserMessageId: previousPrompt, optimisticPromptShown: false };
    expect(resolveTimelineWorking({ ...sendingAlone, ...promptMissing, onlySendBusy: false })).toBe(
      true,
    );
    expect(
      resolveTimelineWorking({
        ...sendingAlone,
        latestUserMessageId: sentPrompt,
        optimisticPromptShown: true,
        isWorking: false,
      }),
    ).toBe(false);
  });

  it("stays on from the shown prompt until the V2 run is running, through the dispatch reset", () => {
    const completedRun: ThreadRunSummary = {
      runId: RunId.make("run-1"),
      status: "completed",
      requestedAt: "2026-10-07T10:00:00.000Z",
      startedAt: "2026-10-07T10:00:01.000Z",
      completedAt: "2026-10-07T10:00:09.000Z",
      assistantMessageId: null,
    };
    const idleRuntime: ThreadRuntimeSummary = {
      status: "completed",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "codex",
      lastError: null,
      updatedAt: "2026-10-07T10:00:09.000Z",
    };
    const dispatch: LocalDispatchSnapshot = {
      startedAt: "2026-10-07T10:01:00.000Z",
      preparingWorktree: false,
      submissionIntent: "foreground",
      latestUserMessageId: previousPrompt,
      latestRunId: completedRun.runId,
      latestRunRequestedAt: completedRun.requestedAt,
      latestRunStartedAt: completedRun.startedAt,
      latestRunCompletedAt: completedRun.completedAt,
      runtimeStatus: idleRuntime.status,
      runtimeUpdatedAt: idleRuntime.updatedAt,
    };
    const timelineWorking = (state: {
      latestRun: ThreadRunSummary;
      runtime: ThreadRuntimeSummary;
      latestUserMessageId: MessageId;
      optimisticPromptShown: boolean;
      /** ChatView resets the dispatch once the send is admitted (it has a submission id). */
      dispatchReset: boolean;
    }) => {
      const phase = derivePhase(state.runtime);
      const sendBusy =
        !state.dispatchReset &&
        !hasServerAcknowledgedLocalDispatch({
          localDispatch: dispatch,
          phase,
          latestRun: state.latestRun,
          latestUserMessageId: state.latestUserMessageId,
          runtime: state.runtime,
          hasPendingApproval: false,
          hasPendingUserInput: false,
          threadError: null,
        });
      const sentRun = state.latestRun.runId === completedRun.runId ? null : state.latestRun;
      return resolveTimelineWorking({
        isWorking: phase === "running" || sendBusy,
        onlySendBusy: sendBusy && phase !== "running",
        dispatchBaselineUserMessageId: dispatch.latestUserMessageId,
        latestUserMessageId: state.latestUserMessageId,
        optimisticPromptShown: state.optimisticPromptShown,
        promptRunStarting: sentRun?.status === "preparing" || sentRun?.status === "starting",
      });
    };
    const newRun = (status: ThreadRunSummary["status"]): ThreadRunSummary => ({
      runId: RunId.make("run-2"),
      status,
      requestedAt: "2026-10-07T10:01:01.000Z",
      startedAt: status === "running" ? "2026-10-07T10:01:04.000Z" : null,
      completedAt: null,
      assistantMessageId: null,
    });
    const runtimeFor = (run: ThreadRunSummary): ThreadRuntimeSummary => ({
      ...idleRuntime,
      status: run.status,
      activeRunId: run.runId,
      updatedAt: run.startedAt ?? run.requestedAt ?? idleRuntime.updatedAt,
    });

    // Sent: only the optimistic prompt is in the list.
    expect(
      timelineWorking({
        latestRun: completedRun,
        runtime: idleRuntime,
        latestUserMessageId: previousPrompt,
        optimisticPromptShown: true,
        dispatchReset: false,
      }),
    ).toBe(true);
    // Admitted (the dispatch is reset) while its run prepares and starts: the
    // row does not drop out, and stays on once the run runs.
    for (const status of ["preparing", "starting", "running"] as const) {
      const run = newRun(status);
      expect(
        timelineWorking({
          latestRun: run,
          runtime: runtimeFor(run),
          latestUserMessageId: sentPrompt,
          optimisticPromptShown: false,
          dispatchReset: true,
        }),
      ).toBe(true);
    }
    // A run held in the queue is not this thread working.
    const held = newRun("queued");
    expect(
      timelineWorking({
        latestRun: held,
        runtime: { ...idleRuntime, status: "queued" },
        latestUserMessageId: sentPrompt,
        optimisticPromptShown: false,
        dispatchReset: true,
      }),
    ).toBe(false);
  });
});
