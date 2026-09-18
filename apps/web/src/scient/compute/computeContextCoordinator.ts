import type {
  ComputeSessionRecord,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeLanguageId,
  EnvironmentId,
} from "@t3tools/contracts";
import { TERMINAL_COMPUTE_SESSION_STATUSES } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  getComputeContext,
  INITIAL_COMPUTE_CONTEXT_GENERATION,
  useComputeContextStore,
  type ComputeContextId,
  type ComputeContextBinding,
} from "./computeContextStore";
import { isComputeCapacityReachedError } from "./computeFileSurfaceModel";

// Close/Stop wins over a replacement still checking readiness or starting.
// Navigation does not cancel work: only the explicit lifecycle commands do.
const replacements = new Map<ComputeContextId, { cancelled: boolean }>();

function cancelReplacement(contextId: ComputeContextId): void {
  const pending = replacements.get(contextId);
  if (pending) pending.cancelled = true;
}

type StopResult = AtomCommandResult<ComputeSessionRecord, unknown>;
type GetResult = AtomCommandResult<ComputeSessionRecord | null, unknown>;

/** A cached exact-id read must never overwrite a newer stream/list observation. */
export function mergeComputeSessionRecords(
  ...sources: ReadonlyArray<Iterable<ComputeSessionRecord>>
): ComputeSessionRecord[] {
  const byId = new Map<string, ComputeSessionRecord>();
  for (const source of sources) {
    for (const record of source) {
      const previous = byId.get(record.sessionId);
      if (
        previous !== undefined &&
        (record.generation < previous.generation ||
          (record.generation === previous.generation &&
            (record.lastActivityAt < previous.lastActivityAt ||
              (TERMINAL_COMPUTE_SESSION_STATUSES.has(previous.status) &&
                !TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status)))))
      )
        continue;
      byId.set(record.sessionId, record);
    }
  }
  return [...byId.values()];
}

export interface ComputeContextCloseInput {
  readonly contextId: ComputeContextId;
  readonly cancelBatchRun?: (input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly runId: NonNullable<ComputeContextBinding["batchRunId"]>;
    readonly waitForExit: true;
  }) => Promise<boolean>;
  readonly stopSession: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly sessionId: ComputeSessionId;
      readonly expectedGeneration: ComputeSessionGeneration;
    };
  }) => Promise<StopResult>;
  readonly getSession: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly cwd: string; readonly sessionId: ComputeSessionId };
  }) => Promise<GetResult>;
}

export interface ComputeContextCloseResult {
  readonly closed: boolean;
  readonly contextId: ComputeContextId;
  readonly error: string | null;
}

function resultError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Unable to stop the compute context.";
}

function isTerminal(record: ComputeSessionRecord | null): record is ComputeSessionRecord {
  return record !== null && TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status);
}

function isTerminalForSession(
  record: ComputeSessionRecord | null,
  sessionId: ComputeSessionId,
): record is ComputeSessionRecord {
  return record !== null && record.sessionId === sessionId && isTerminal(record);
}

function thrownError(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to stop the compute context.";
}

/**
 * Stop exactly one owner. A generation refresh may retry once, but it never retargets
 * another session and it leaves the surface present when shutdown cannot be confirmed.
 */
export async function closeComputeContext(
  input: ComputeContextCloseInput,
): Promise<ComputeContextCloseResult> {
  cancelReplacement(input.contextId);
  // Mark the owner before awaiting any child, so a Run click cannot add work
  // while close is in flight. Navigation never calls this explicit-close path.
  useComputeContextStore.getState().markClosing(input.contextId);
  const children = Object.values(useComputeContextStore.getState().bindings).filter(
    (binding) => binding.parentContextId === input.contextId,
  );
  const results = await Promise.all([
    stopComputeContext(input),
    ...children.map((child) => stopComputeContext({ ...input, contextId: child.contextId })),
  ]);
  const failure = results.find((result) => !result.closed);
  if (failure !== undefined) {
    const error = failure.error ?? "Unable to stop all work owned by this tab.";
    useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
    return { closed: false, contextId: input.contextId, error };
  }
  return { closed: true, contextId: input.contextId, error: null };
}

/** Stop the displayed context only; closing its tab also stops all owned children. */
export async function stopComputeContext(
  input: ComputeContextCloseInput,
): Promise<ComputeContextCloseResult> {
  cancelReplacement(input.contextId);
  return stopOwnedComputeContext(input);
}

async function stopOwnedComputeContext(
  input: ComputeContextCloseInput,
): Promise<ComputeContextCloseResult> {
  const binding = getComputeContext(input.contextId);
  if (binding?.batchRunId !== undefined) {
    useComputeContextStore.getState().markClosing(input.contextId);
    let closed = false;
    try {
      closed =
        input.cancelBatchRun !== undefined &&
        (await input.cancelBatchRun({
          environmentId: binding.environmentId,
          cwd: binding.cwd,
          runId: binding.batchRunId,
          waitForExit: true,
        }));
    } catch {
      /* Keep the owner when shutdown cannot be confirmed. */
    }
    if (!closed) {
      const error = "Unable to confirm that this tab's MATLAB batch run has stopped.";
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    return { closed: true, contextId: input.contextId, error: null };
  }
  if (binding === null || binding.sessionId === null) {
    return { closed: true, contextId: input.contextId, error: null };
  }

  useComputeContextStore.getState().markClosing(input.contextId);
  const sessionId = binding.sessionId;
  let expectedGeneration = binding.generation ?? INITIAL_COMPUTE_CONTEXT_GENERATION;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let stopped: StopResult;
    try {
      stopped = await input.stopSession({
        environmentId: binding.environmentId,
        input: { cwd: binding.cwd, sessionId, expectedGeneration },
      });
    } catch (error) {
      const message = thrownError(error);
      useComputeContextStore.getState().markCloseFailed({
        contextId: input.contextId,
        error: message,
      });
      return { closed: false, contextId: input.contextId, error: message };
    }
    if (stopped._tag === "Success" && isTerminalForSession(stopped.value, sessionId)) {
      useComputeContextStore.getState().markSessionTerminal({
        contextId: input.contextId,
        sessionId,
        generation: stopped.value.generation,
        lifecycle: "terminal",
      });
      return { closed: true, contextId: input.contextId, error: null };
    }
    if (isAtomCommandInterrupted(stopped)) {
      const error = "Stopping the compute context was interrupted.";
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }

    // Re-read this exact owner after a lost response or generation race. The
    // server confirms physical cleanup before returning a terminal exact read.
    let current: GetResult;
    try {
      current = await input.getSession({
        environmentId: binding.environmentId,
        input: { cwd: binding.cwd, sessionId },
      });
    } catch (error) {
      const message = thrownError(error);
      useComputeContextStore.getState().markCloseFailed({
        contextId: input.contextId,
        error: message,
      });
      return { closed: false, contextId: input.contextId, error: message };
    }
    if (current._tag === "Success" && isTerminalForSession(current.value, sessionId)) {
      useComputeContextStore.getState().markSessionTerminal({
        contextId: input.contextId,
        sessionId,
        generation: current.value.generation,
        lifecycle: "terminal",
      });
      return { closed: true, contextId: input.contextId, error: null };
    }
    if (current._tag !== "Success" || current.value === null) {
      const error =
        current._tag === "Success"
          ? stopped._tag === "Failure"
            ? resultError(stopped)
            : "Stop did not return a terminal compute session."
          : resultError(current);
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    if (current.value.sessionId !== sessionId) {
      const error = "The owned compute session changed while closing.";
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    if (current.value.generation === expectedGeneration || attempt === 1) {
      const error =
        stopped._tag === "Success"
          ? "Stop returned a non-terminal compute session."
          : resultError(stopped);
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    expectedGeneration = current.value.generation;
    useComputeContextStore.getState().updateClosingGeneration({
      contextId: input.contextId,
      sessionId,
      generation: expectedGeneration,
    });
  }

  const error = "Unable to confirm compute context shutdown.";
  useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
  return { closed: false, contextId: input.contextId, error };
}

export type ComputeContextReplacementResult =
  | { readonly kind: "started"; readonly session: ComputeSessionRecord }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Replace one explicitly confirmed owner, never its history or global default.
 * Preparation is read-only. A replacement is reserved only after confirmed
 * shutdown, and an uncertain start retains ownership until cleanup is confirmed.
 */
export async function replaceComputeContextSession(
  input: ComputeContextCloseInput & {
    readonly expectedSession: ComputeSessionRecord;
    readonly replacementSessionId: ComputeSessionId;
    readonly prepareRuntime: () => Promise<{
      readonly languageId: ComputeLanguageId;
      readonly executable: string;
    }>;
    readonly startSession: (input: {
      readonly environmentId: EnvironmentId;
      readonly input: {
        readonly cwd: string;
        readonly sessionId: ComputeSessionId;
        readonly languageId: ComputeLanguageId;
        readonly executable: string;
      };
    }) => Promise<StopResult>;
  },
): Promise<ComputeContextReplacementResult> {
  if (replacements.has(input.contextId)) return { kind: "cancelled" };
  const expected = input.expectedSession;
  const binding = getComputeContext(input.contextId);
  if (
    binding === null ||
    expected.lifetime === "fresh" ||
    binding.parentContextId !== undefined ||
    binding.lifecycle !== "live" ||
    binding.sessionId !== expected.sessionId ||
    binding.generation !== expected.generation
  )
    return { kind: "failed", error: "The owned session changed. Choose the current result again." };

  const pending = { cancelled: false };
  replacements.set(input.contextId, pending);
  let reserved = false;
  const cleanup = async () => {
    if (getComputeContext(input.contextId)?.sessionId !== input.replacementSessionId) return;
    await stopOwnedComputeContext(input);
  };
  try {
    const runtime = await input.prepareRuntime();
    const current = getComputeContext(input.contextId);
    if (
      pending.cancelled ||
      current?.lifecycle !== "live" ||
      current.sessionId !== expected.sessionId ||
      current.generation !== expected.generation
    ) {
      return { kind: "cancelled" };
    }
    const closed = await stopOwnedComputeContext(input);
    if (!closed.closed)
      return { kind: "failed", error: closed.error ?? "Shutdown was not confirmed." };
    const stopped = getComputeContext(input.contextId);
    if (
      pending.cancelled ||
      stopped?.lifecycle !== "terminal" ||
      stopped.sessionId !== expected.sessionId
    ) {
      return { kind: "cancelled" };
    }
    reserved = useComputeContextStore.getState().reserveSession({
      contextId: input.contextId,
      sessionId: input.replacementSessionId,
      generation: INITIAL_COMPUTE_CONTEXT_GENERATION,
    });
    if (!reserved) return { kind: "cancelled" };
    const started = await input.startSession({
      environmentId: binding.environmentId,
      input: { cwd: binding.cwd, sessionId: input.replacementSessionId, ...runtime },
    });
    if (started._tag !== "Success") {
      const error = squashAtomCommandFailure(started);
      if (isComputeCapacityReachedError(error)) {
        useComputeContextStore.getState().releasePendingReservation({
          contextId: input.contextId,
          sessionId: input.replacementSessionId,
          generation: INITIAL_COMPUTE_CONTEXT_GENERATION,
        });
        return {
          kind: "failed",
          error:
            "Compute capacity reached. Stop an unused session, then try again. No code was run.",
        };
      }
      await cleanup();
      return isAtomCommandInterrupted(started)
        ? { kind: "cancelled" }
        : { kind: "failed", error: resultError(started) };
    }
    if (pending.cancelled) {
      await cleanup();
      return { kind: "cancelled" };
    }
    if (
      started.value.sessionId !== input.replacementSessionId ||
      started.value.languageId !== runtime.languageId ||
      started.value.runtime?.executable !== runtime.executable ||
      started.value.status !== "ready"
    ) {
      await cleanup();
      return { kind: "failed", error: "The requested runtime was not started. No code was run." };
    }
    if (
      !useComputeContextStore.getState().bindSession({
        contextId: input.contextId,
        sessionId: started.value.sessionId,
        generation: started.value.generation,
      })
    ) {
      await cleanup();
      return { kind: "cancelled" };
    }
    return { kind: "started", session: started.value };
  } catch (error) {
    if (reserved) await cleanup();
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : "Unable to start a new session.",
    };
  } finally {
    replacements.delete(input.contextId);
  }
}
