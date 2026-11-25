// @effect-diagnostics nodeBuiltinImport:off -- session ids are random UUIDs.
import * as NodeCrypto from "node:crypto";

import {
  ComputeLanguageId,
  ComputeSessionId,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeSessionOwner,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { ScientComputeToolError } from "./tools.ts";

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { py: "python", jl: "julia" };

type ToolErrorCode = ConstructorParameters<typeof ScientComputeToolError>[0]["code"];
export const toolError = (code: ToolErrorCode, message: string) =>
  new ScientComputeToolError({ code, message });
export const computeFailed = (error: { readonly message: string }) =>
  toolError("compute-failed", error.message);

/** The thread's project and identity; every compute tool acts in the caller's own project. */
export const agentScope = Effect.fn("ScientComputeToolkit.scope")(function* () {
  const invocation = yield* AgentInvocationContext.AgentInvocationContext;
  const workspace = yield* consumeAgentWorkspace().pipe(
    Effect.mapError((error) => toolError(error.code, error.message)),
  );
  return {
    cwd: workspace.binding.canonicalRoot,
    threadId: invocation.threadId as string,
    gateway: yield* ComputeMcpGateway,
  };
});
export type AgentScope = Effect.Success<ReturnType<typeof agentScope>>;

export const isLive = (session: ComputeSessionRecord) =>
  !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status);

export function agentComputeLanguageId(requestedLanguage = "python") {
  const normalized = requestedLanguage.trim().toLowerCase();
  return ComputeLanguageId.make(LANGUAGE_ALIASES[normalized] ?? normalized);
}

/**
 * One find-or-start at a time per workspace, owner and language, so first calls share it. A lock
 * lives only while someone holds or waits for it.
 */
const acquiring = new Map<string, { readonly lock: Semaphore.Semaphore; callers: number }>();
const oneAtATime = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const entry = acquiring.get(key) ?? { lock: Semaphore.makeUnsafe(1), callers: 0 };
      entry.callers += 1;
      acquiring.set(key, entry);
      return entry;
    }),
    (entry) => entry.lock.withPermits(1)(effect),
    (entry) =>
      Effect.sync(() => {
        entry.callers -= 1;
        if (entry.callers === 0) acquiring.delete(key);
      }),
  );

/** The live session this owner holds for the language, started on first use. */
export const ownedSession = Effect.fn("ScientComputeToolkit.ownedSession")(function* (
  scope: AgentScope,
  requestedLanguage: string | undefined,
  owner: ComputeSessionOwner,
) {
  const languageId = agentComputeLanguageId(requestedLanguage);
  const holder = owner._tag === "agent" ? owner.threadId : owner.path;
  const key = [scope.cwd, languageId, owner._tag, holder].join("\u0000");
  return yield* oneAtATime(key, findOrStart(scope, languageId, owner));
}, Effect.mapError(computeFailed));

const findOrStart = Effect.fn("ScientComputeToolkit.findOrStartSession")(function* (
  scope: AgentScope,
  languageId: ComputeLanguageId,
  owner: ComputeSessionOwner,
) {
  const sessions = yield* scope.gateway.listSessions({ cwd: scope.cwd });
  const existing = sessions.find(
    (session) =>
      isLive(session) &&
      session.lifetime !== "fresh" &&
      session.languageId === languageId &&
      session.owner !== undefined &&
      JSON.stringify(session.owner) === JSON.stringify(owner),
  );
  if (existing !== undefined) return existing;
  // The same order as a person's Run: the project's environment comes first.
  return yield* scope.gateway.startSession({
    cwd: scope.cwd,
    sessionId: ComputeSessionId.make(`agent-${NodeCrypto.randomUUID()}`),
    languageId,
    executable: null,
    owner,
  });
});
