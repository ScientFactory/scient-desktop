import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";

import type { NativeSessionUpdate } from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import { ompPlanMode, ompProposedPlan, parseOmpPlanCommand, runOmpPlanTurn } from "./OmpPlan.ts";

/** A `/plan` message against an agent that answers `plan` with `refusal`, if given. */
const planTurn = (text: string, refusal?: string) =>
  Effect.gen(function* () {
    const sent: Array<unknown> = [];
    const updates: Array<NativeSessionUpdate["type"]> = [];
    const notices: Array<string> = [];
    const command = parseOmpPlanCommand(text);
    if (command === null) throw new Error(`not a plan command: ${text}`);
    const answered = yield* runOmpPlanTurn({
      client: {
        command: (body) => {
          sent.push(body.op);
          return refusal === undefined
            ? Effect.succeed({ type: "response" as const, command: "plan", success: true })
            : Effect.fail(new OmpRpcCommandError({ command: "plan", detail: refusal }));
        },
      },
      command,
      nativeTurnId: "turn-1",
      runtime: { accepted: () => Effect.void },
      onUpdate: (update) => Effect.sync(() => void updates.push(update.type)),
      notice: (message) => Effect.sync(() => void notices.push(message)),
      redact: (value) => value,
    });
    return { answered, sent, updates, notices };
  });

it.effect("turns plan mode on and leaves the task to be sent as the prompt", () =>
  Effect.gen(function* () {
    assert.deepEqual(parseOmpPlanCommand("/plan  compare the two models "), {
      type: "enter",
      task: "compare the two models",
    });
    const turn = yield* planTurn("/plan compare the two models");
    assert.deepEqual(turn, { answered: false, sent: ["enter"], updates: [], notices: [] });
  }),
);

it.effect("answers in the conversation when there is nothing to send", () =>
  Effect.gen(function* () {
    const off = yield* planTurn("/plan off");
    assert.deepEqual(off.sent, ["exit"]);
    assert.deepEqual(off.notices, ["Plan mode is off."]);
    assert.deepEqual(off.updates, ["offered", "accepted"]);
    assert.isTrue((yield* planTurn("/plan")).answered);
    const old = yield* planTurn("/plan the analysis", "Unknown command: plan");
    assert.deepEqual(old.notices, [
      "This Scient Agent version cannot plan. Update Scient Agent to use /plan.",
    ]);
    const refused = yield* planTurn(
      "/plan the analysis",
      "Drop or finish the goal before planning.",
    );
    assert.deepEqual(refused.notices, ["Drop or finish the goal before planning."]);
  }),
);

it("reads the plan the agent proposed, and whether it is planning, from its frames", () => {
  assert.strictEqual(
    ompProposedPlan({ type: "plan_proposed", raw: { type: "plan_proposed", markdown: "# Fit" } }),
    "# Fit",
  );
  assert.isFalse(
    ompPlanMode({ type: "plan_updated", raw: { type: "plan_updated", enabled: false } }),
  );
  assert.isUndefined(ompPlanMode({ type: "plan_proposed", raw: { markdown: "# Fit" } }));
  assert.isUndefined(ompProposedPlan({ type: "goal_updated", goal: null }));
  assert.isNull(parseOmpPlanCommand("/planet"));
});
