import { assert, it } from "@effect/vitest";
import { parseGoalCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";

import type { NativeSessionUpdate } from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import { ompGoalUpdate, runOmpGoalTurn } from "./OmpGoal.ts";

const goal = (objective: string, status: string) => ({
  id: "goal-1",
  objective,
  status,
  tokensUsed: 1200,
  timeUsedSeconds: 30,
  createdAt: 1,
  updatedAt: 2,
});

/** A `/goal` turn against an agent that holds `held` and refuses what `refuse` names. */
const goalTurn = (text: string, held: ReturnType<typeof goal> | null, refuse?: string) =>
  Effect.gen(function* () {
    const sent: Array<Record<string, unknown>> = [];
    const updates: Array<NativeSessionUpdate["type"]> = [];
    const notices: Array<string> = [];
    const accepted: Array<boolean | undefined> = [];
    let current = held;
    const command = parseGoalCommand({ text });
    if (command === null) throw new Error(`not a goal command: ${text}`);
    yield* runOmpGoalTurn({
      client: {
        command: (body) => {
          sent.push(body);
          if (body.op === refuse)
            return Effect.fail(
              new OmpRpcCommandError({
                command: "goal",
                detail: "Exit plan mode before starting a goal.",
              }),
            );
          if (body.op === "drop") current = null;
          if (body.op === "create") current = goal(String(body.objective), "active");
          return Effect.succeed({
            type: "response" as const,
            command: "goal",
            success: true,
            data: { goal: current, state: null },
          });
        },
      },
      command,
      nativeTurnId: "turn-1",
      runtime: {
        accepted: (_id, agentInvoked) => Effect.sync(() => void accepted.push(agentInvoked)),
      },
      onUpdate: (update) => Effect.sync(() => void updates.push(update.type)),
      notice: (message) => Effect.sync(() => void notices.push(message)),
      redact: (value) => value,
    });
    return { sent: sent.map((body) => body.op), updates, notices, accepted };
  });

it.effect(
  "replaces the agent's goal with a new objective and ends the turn as a local command",
  () =>
    Effect.gen(function* () {
      const turn = yield* goalTurn("/goal all tests pass", goal("old objective", "paused"));
      assert.deepEqual(turn.sent, ["get", "drop", "create"]);
      assert.deepEqual(turn.updates, ["offered", "accepted"]);
      assert.deepEqual(turn.notices, []);
      assert.deepEqual(turn.accepted, [false]);
    }),
);

it.effect("answers a refusal, a goal to show, and nothing to clear in the conversation", () =>
  Effect.gen(function* () {
    const refused = yield* goalTurn("/goal write the proof", null, "create");
    assert.deepEqual(refused.notices, ["Exit plan mode before starting a goal."]);
    assert.deepEqual(refused.accepted, [false]);
    const shown = yield* goalTurn("/goal", goal("fit the model", "budget-limited"));
    assert.deepEqual(shown.notices, ["Goal budget limited: fit the model"]);
    const cleared = yield* goalTurn("/goal clear", null);
    assert.deepEqual(cleared.sent, ["get"]);
    assert.deepEqual(cleared.notices, ["No goal is set."]);
  }),
);

it("maps the agent's goal events to the thread's goal, a dropped goal to none", () => {
  assert.deepEqual(ompGoalUpdate({ type: "goal_updated", goal: goal("fit", "budget-limited") }), {
    goal: {
      objective: "fit",
      status: "budget_limited",
      tokensUsed: 1200,
      tokenBudget: null,
      timeUsedSeconds: 30,
    },
  });
  assert.deepEqual(ompGoalUpdate({ type: "goal_updated", goal: goal("fit", "dropped") }), {
    goal: null,
  });
  assert.isUndefined(ompGoalUpdate({ type: "notice", message: "hi" }));
});
