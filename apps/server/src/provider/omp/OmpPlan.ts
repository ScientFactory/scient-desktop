import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OmpRpcClient } from "effect-omp-rpc/client";

import type { NativeSessionUpdate } from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import type { OmpSessionRuntime } from "./OmpSessionRuntime.ts";

/** Scient Agent's plan mode; the agent's own `/plan` is a terminal command. */
export const OMP_PLAN_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "plan",
  description: "Have Scient Agent plan, and approve the plan before it changes anything",
  input: { hint: "What to plan, or off" },
};

export type OmpPlanCommand =
  | { readonly type: "enter"; readonly task: string }
  | { readonly type: "exit" };

/** Reads a `/plan` message: what to plan (possibly nothing yet), or `off`. */
export const parseOmpPlanCommand = (text: string): OmpPlanCommand | null => {
  const match = /^\/plan(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const task = (match[1] ?? "").trim();
  return /^(?:off|exit|stop)$/iu.test(task) ? { type: "exit" } : { type: "enter", task };
};

// The agent sends the plan it proposes as a top-level frame the client projects as `raw`.
const PlanProposed = Schema.Struct({
  type: Schema.Literal("plan_proposed"),
  raw: Schema.Struct({ markdown: Schema.String }),
});
const decodePlanProposed = Schema.decodeUnknownOption(PlanProposed);

/** The markdown of a plan the agent proposed, or undefined for any other event. */
export const ompProposedPlan = (event: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodePlanProposed(event), (frame) => frame.raw.markdown));

// The agent reports each time plan mode turns on or off, including after an approval.
const PlanUpdated = Schema.Struct({
  type: Schema.Literal("plan_updated"),
  raw: Schema.Struct({ enabled: Schema.Boolean }),
});
const decodePlanUpdated = Schema.decodeUnknownOption(PlanUpdated);

/** Whether plan mode is now on, or undefined for any other event. */
export const ompPlanMode = (event: unknown): boolean | undefined =>
  Option.getOrUndefined(Option.map(decodePlanUpdated(event), (frame) => frame.raw.enabled));

const UNSUPPORTED = /unknown command/iu;

/**
 * Applies a `/plan` command. Returns true when the turn was answered here: plan
 * mode turned off, turned on with nothing to plan yet, or the agent refused.
 * With a task, plan mode is on and the caller sends the task as the prompt.
 */
export const runOmpPlanTurn = Effect.fn("OmpPlan.turn")(function* (input: {
  readonly client: Pick<OmpRpcClient, "command">;
  readonly command: OmpPlanCommand;
  readonly nativeTurnId: string;
  readonly runtime: Pick<OmpSessionRuntime, "accepted">;
  readonly onUpdate: (update: NativeSessionUpdate) => Effect.Effect<void>;
  readonly notice: (message: string) => Effect.Effect<void>;
  readonly redact: (text: string) => string;
}) {
  const answer = yield* input.client.command({ type: "plan", op: input.command.type }).pipe(
    Effect.as(
      input.command.type === "exit"
        ? "Plan mode is off."
        : input.command.task === ""
          ? "Plan mode is on. Describe what to plan; Scient Agent proposes a plan and waits for your approval before it changes anything."
          : undefined,
    ),
    Effect.catchTags({
      OmpRpcCommandError: (refusal) =>
        Effect.succeed(
          UNSUPPORTED.test(refusal.detail)
            ? "This Scient Agent version cannot plan. Update Scient Agent to use /plan."
            : input.redact(refusal.detail),
        ),
    }),
  );
  if (answer === undefined) return false;
  yield* input.onUpdate({ type: "offered", nativeTurnId: input.nativeTurnId });
  yield* input.onUpdate({ type: "accepted", nativeTurnId: input.nativeTurnId });
  yield* input.notice(answer);
  // A command the agent handles itself reports no result; the idle session ends the turn.
  yield* input.runtime.accepted(input.nativeTurnId, false, "prompt", input.nativeTurnId);
  return true;
});
