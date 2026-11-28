import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
// SCIENT-FORK:START — Scient Accounts: a silent row is shown, never alerted.
import * as Schema from "effect/Schema";
// SCIENT-FORK:END
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  attentionTransitionRows,
  terminalTransitionRows,
  shouldAlertForActivity,
  // SCIENT-FORK:START — Scient Accounts: a silent row is shown, never alerted.
  alertForTerminalAggregate,
  // SCIENT-FORK:END
} from "./agentActivityAlerts.ts";
// SCIENT-FORK:START — Scient Accounts: a silent row is shown, never alerted.
import { androidAlertForState } from "./FcmDeliveries.ts";
// SCIENT-FORK:END

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
// SCIENT-FORK:START — Scient Accounts: a silent row is shown, never alerted.
const encodeStored = Schema.encodeSync(Schema.fromJsonString(RelayAgentActivityState));
const decodeStored = Schema.decodeSync(Schema.fromJsonString(RelayAgentActivityState));
// SCIENT-FORK:END
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

describe("shared agent activity policy", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate(running),
          nextAggregate: next,
          preferences,
        }),
      ).toMatchObject([{ threadId: state.threadId }]);
    },
  );

  it("allows fresh unobserved completions for events, but not reconciliation or repeats", () => {
    const previousAggregate = aggregate([
      { ...state, threadId: ThreadId.make("old"), phase: "completed" },
    ]);
    const nextAggregate = aggregate([{ ...state, phase: "completed" }]);
    const input = { previousAggregate, nextAggregate, preferences, nowMs: 0 };
    expect(terminalTransitionRows(input)).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true })).toHaveLength(1);
    expect(
      terminalTransitionRows({
        ...input,
        includeUnobserved: true,
        previousAggregate: nextAggregate,
      }),
    ).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true, nowMs: 180_000 })).toEqual(
      [],
    );
  });

  it("distinguishes equal thread IDs across environments", () => {
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const other = { ...waiting, environmentId: EnvironmentId.make("other") };
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences,
      }),
    ).toMatchObject([{ environmentId: other.environmentId }]);
  });

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
  });

  // SCIENT-FORK:START — Scient Accounts: a silent row is shown, never alerted.
  it("shows a silent row, fresh and truly dated, and alerts on it on neither platform", () => {
    const done = { ...state, phase: "completed" as const, headline: "Signed in" };
    const silent = { ...done, silent: true as const };
    // Kept as the relay keeps a row, in its stored JSON.
    expect(decodeStored(encodeStored(silent))).toEqual(silent);
    const previousAggregate = aggregate([state]);
    const nextAggregate = aggregate([silent]);
    expect(nextAggregate.activities).toMatchObject([{ phase: "completed", silent: true }]);
    const transition = { previousAggregate, preferences, nowMs: 0, includeUnobserved: true };
    // The same row, not silent, would alert: only the flag keeps it quiet.
    expect(
      terminalTransitionRows({ ...transition, nextAggregate: aggregate([done]) }),
    ).toHaveLength(1);
    expect(terminalTransitionRows({ ...transition, nextAggregate })).toEqual([]);
    expect(shouldAlertForActivity({ ...silent, preferences, nowMs: 0 })).toBe(false);
    expect(alertForTerminalAggregate({ aggregate: nextAggregate, preferences })).toBeNull();
    expect(androidAlertForState(silent, preferences, 0)).toBeNull();
    expect(androidAlertForState(done, preferences, 0)).not.toBeNull();
    const waiting = { ...state, phase: "waiting_for_approval" as const, silent: true as const };
    expect(
      attentionTransitionRows({
        previousAggregate,
        nextAggregate: aggregate([waiting]),
        preferences,
      }),
    ).toEqual([]);
  });
  // SCIENT-FORK:END
});
