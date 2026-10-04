import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "../../provider/acp/AcpRuntimeModel.ts";
import { unknownRecord } from "../../provider/acp/AcpClientPolicy.ts";

const SUBAGENT_WINDOW = 3_600_000;
const WAIT_MARGIN = 60_000;
const formatWindow = (millis: number) =>
  millis % 60_000 === 0
    ? `${millis / 60_000}m`
    : millis % 1_000 === 0
      ? `${millis / 1_000}s`
      : `${millis}ms`;

/** One native prompt's silence budget; a new prompt never inherits an idle deadline or tasks. */
export const makeDroidInactivity = Effect.fnUntraced(function* (idleMillis: number) {
  const tools = new Map<string, AcpToolCallState>();
  const background = new Map<string, string>();
  const openTasks = new Set<string>();
  const endedTasks = new Set<string>();
  const endTask = (id: string) => {
    openTasks.delete(id);
    endedTasks.add(id);
  };
  let userWaits = 0;
  let lastActivity = yield* Clock.currentTimeMillis;
  const touch = Effect.gen(function* () {
    lastActivity = yield* Clock.currentTimeMillis;
  });
  const observe = Effect.fnUntraced(function* (notification: EffectAcpSchema.SessionNotification) {
    yield* touch;
    for (const event of parseSessionUpdateEvent(notification).events) {
      if (event._tag !== "ToolCallUpdated") continue;
      const tool = mergeToolCallState(tools.get(event.toolCall.toolCallId), event.toolCall);
      tools.set(tool.toolCallId, tool);
      const input = unknownRecord(tool.data.rawInput);
      const isTask =
        (typeof input?.subagent_type === "string" && input.subagent_type.trim().length > 0) ||
        tool.title?.trim().toLowerCase() === "task" ||
        openTasks.has(tool.toolCallId);
      const output =
        typeof unknownRecord(tool.data.rawOutput)?.text === "string"
          ? String(unknownRecord(tool.data.rawOutput)?.text)
          : (tool.detail ?? "");
      if (isTask && !endedTasks.has(tool.toolCallId)) {
        if (tool.status === "failed") endTask(tool.toolCallId);
        else if (tool.status === "completed") {
          const id = /^Task launched in background\b/iu.test(output)
            ? /^task_id:[ \t]*(\S+)/imu.exec(output)?.[1]
            : undefined;
          if (id) {
            background.set(id, tool.toolCallId);
            openTasks.add(tool.toolCallId);
          } else endTask(tool.toolCallId);
        } else openTasks.add(tool.toolCallId);
      }
      if (tool.status === "completed" && typeof input?.task_id === "string") {
        const status = /^Status:[ \t]*(.*)$/imu.exec(output)?.[1]?.trim().toLowerCase();
        if (
          status &&
          /^(completed|complete|done|finished|succeeded|failed|error|errored|timed_out|timed out|cancelled|canceled|killed|stopped|aborted)$/u.test(
            status,
          )
        ) {
          const task = background.get(input.task_id);
          if (task) endTask(task);
        }
      }
    }
  });
  const window = () => {
    let wait: number | "unbounded" | undefined;
    for (const tool of tools.values()) {
      if (tool.status === "completed" || tool.status === "failed") continue;
      const input = unknownRecord(tool.data.rawInput);
      if (typeof input?.task_id !== "string" || input.block !== true) continue;
      wait =
        typeof input.timeout !== "number" ||
        !Number.isFinite(input.timeout) ||
        input.timeout <= 0 ||
        wait === "unbounded"
          ? "unbounded"
          : Math.max(wait ?? 0, input.timeout);
    }
    const cap = openTasks.size > 0 || wait === "unbounded" ? SUBAGENT_WINDOW : idleMillis;
    return { millis: typeof wait === "number" ? Math.max(cap, wait + WAIT_MARGIN) : cap, wait };
  };
  let expiry: EffectAcpErrors.AcpRequestError | undefined;
  const awaitExpiry = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Math.min(15_000, Math.max(25, Math.floor(idleMillis / 4))));
      if (userWaits > 0) continue;
      const allowance = window();
      if ((yield* Clock.currentTimeMillis) < lastActivity + allowance.millis) continue;
      const detail =
        openTasks.size > 0
          ? ` while executing ${openTasks.size} subagent task(s)`
          : allowance.wait !== undefined
            ? " while waiting for a sub-agent"
            : "";
      expiry = new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: `Droid turn exceeded the idle timeout (${formatWindow(allowance.millis)})${detail}.`,
      });
      return yield* expiry;
    }
  });
  const waitingForUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        userWaits += 1;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          userWaits -= 1;
        }).pipe(Effect.andThen(touch)),
    );
  return {
    observe,
    waitingForUser,
    awaitExpiry,
    isExpiry: (error: unknown) => error === expiry && expiry !== undefined,
  };
});
