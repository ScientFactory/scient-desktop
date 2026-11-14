import type {
  OrchestrationV2GoalCommand,
  OrchestrationV2ProviderGoal,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OmpRpcClient } from "effect-omp-rpc/client";

import type { NativeSessionUpdate } from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import type { OmpSessionRuntime } from "./OmpSessionRuntime.ts";

/** Scient Agent's goal mode; the agent's own `/goal` is a terminal command. */
export const OMP_GOAL_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "goal",
  description: "Set a goal Scient Agent keeps working toward until it is done",
  input: { hint: "Objective, or pause, resume, clear" },
};

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const AgentGoal = Schema.Struct({
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "budget-limited", "complete", "dropped"]),
  tokensUsed: Schema.optional(Count),
  tokenBudget: Schema.optional(Count),
  timeUsedSeconds: Schema.optional(Count),
});
type AgentGoal = typeof AgentGoal.Type;
const GoalUpdated = Schema.Struct({
  type: Schema.Literal("goal_updated"),
  goal: Schema.NullOr(AgentGoal),
});
const GoalResult = Schema.Struct({ goal: Schema.NullOr(AgentGoal) });
const decodeGoalUpdated = Schema.decodeUnknownOption(GoalUpdated);
const decodeGoalResult = Schema.decodeUnknownOption(GoalResult);

const PROVIDER_STATUS = {
  active: "active",
  paused: "paused",
  "budget-limited": "budget_limited",
  complete: "complete",
} as const satisfies Record<
  Exclude<AgentGoal["status"], "dropped">,
  OrchestrationV2ProviderGoal["status"]
>;

/** The goal the thread shows; a dropped goal is none. */
const providerGoal = (goal: AgentGoal | null): OrchestrationV2ProviderGoal | null => {
  const objective = goal?.objective.trim();
  if (!goal || !objective || goal.status === "dropped") return null;
  return {
    objective,
    status: PROVIDER_STATUS[goal.status],
    ...(goal.tokensUsed === undefined ? {} : { tokensUsed: Math.trunc(goal.tokensUsed) }),
    tokenBudget: goal.tokenBudget === undefined ? null : Math.trunc(goal.tokenBudget),
    ...(goal.timeUsedSeconds === undefined
      ? {}
      : { timeUsedSeconds: Math.trunc(goal.timeUsedSeconds) }),
  };
};

/** The thread's goal after a `goal_updated` event, or undefined for any other event. */
export const ompGoalUpdate = (
  event: unknown,
): { readonly goal: OrchestrationV2ProviderGoal | null } | undefined =>
  Option.getOrUndefined(
    Option.map(decodeGoalUpdated(event), (update) => ({ goal: providerGoal(update.goal) })),
  );

type GoalOp =
  | { readonly op: "get" | "pause" | "resume" | "drop" }
  | { readonly op: "create"; readonly objective: string };

/**
 * What a `/goal` command asks of the agent's `goal` command. The agent refuses a
 * second goal, so a new objective replaces the one it holds, as Codex does.
 */
const ompGoalOps = (
  command: OrchestrationV2GoalCommand,
  current: AgentGoal | null,
): ReadonlyArray<GoalOp> => {
  const held = current !== null && current.status !== "complete" && current.status !== "dropped";
  switch (command.type) {
    case "show":
      return [];
    case "clear":
      return held ? [{ op: "drop" }] : [];
    case "pause":
      return [{ op: "pause" }];
    case "resume":
      return [{ op: "resume" }];
    case "set":
      return [
        ...(held ? [{ op: "drop" } as const] : []),
        { op: "create", objective: command.objective },
      ];
  }
};

const describe = (goal: OrchestrationV2ProviderGoal | null): string =>
  goal === null ? "No goal is set." : `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;

/**
 * Runs a `/goal` command through the agent's `goal` command. The goal row shows
 * a goal that was set, paused or resumed; the returned text answers the rest.
 * Fails with the agent's refusal (`OmpRpcCommandError`), which is an answer too.
 */
const runOmpGoalCommand = Effect.fn("OmpGoal.run")(function* (
  client: Pick<OmpRpcClient, "command">,
  command: OrchestrationV2GoalCommand,
) {
  const send = (op: GoalOp) =>
    client
      .command({ type: "goal", ...op })
      .pipe(
        Effect.map((response) => Option.getOrNull(decodeGoalResult(response.data))?.goal ?? null),
      );
  const current = yield* send({ op: "get" });
  let goal = current;
  for (const op of ompGoalOps(command, current)) goal = yield* send(op);
  switch (command.type) {
    case "show":
      return describe(providerGoal(goal));
    case "clear":
      return current === null ? describe(null) : "Goal cleared.";
    default:
      return undefined;
  }
});

/**
 * A `/goal` turn: the agent's `goal` command in place of a prompt. The agent
 * starts the goal's own turns afterwards, which arrive as turns it began.
 */
export const runOmpGoalTurn = Effect.fn("OmpGoal.turn")(function* (input: {
  readonly client: Pick<OmpRpcClient, "command">;
  readonly command: OrchestrationV2GoalCommand;
  readonly nativeTurnId: string;
  readonly runtime: Pick<OmpSessionRuntime, "accepted">;
  readonly onUpdate: (update: NativeSessionUpdate) => Effect.Effect<void>;
  readonly notice: (message: string) => Effect.Effect<void>;
  readonly redact: (text: string) => string;
}) {
  yield* input.onUpdate({ type: "offered", nativeTurnId: input.nativeTurnId });
  const answer = yield* runOmpGoalCommand(input.client, input.command).pipe(
    Effect.catchTags({
      OmpRpcCommandError: (refusal) => Effect.succeed(input.redact(refusal.detail)),
    }),
  );
  yield* input.onUpdate({ type: "accepted", nativeTurnId: input.nativeTurnId });
  if (answer !== undefined) yield* input.notice(answer);
  // A command the agent handles itself reports no result; the idle session ends the turn.
  yield* input.runtime.accepted(input.nativeTurnId, false, "prompt", input.nativeTurnId);
});
