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
  if (!invocation.capabilities.has("compute")) {
    return yield* toolError(
      "capability-unavailable",
      "This provider session does not grant Scient Compute access.",
    );
  }
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

/** The live session this owner holds for the language, started on first use. */
export const ownedSession = Effect.fn("ScientComputeToolkit.ownedSession")(function* (
  scope: AgentScope,
  requestedLanguage: string | undefined,
  owner: ComputeSessionOwner,
) {
  const normalized = (requestedLanguage ?? "python").trim().toLowerCase();
  const languageId = ComputeLanguageId.make(LANGUAGE_ALIASES[normalized] ?? normalized);
  const sessions = yield* scope.gateway.listSessions({ cwd: scope.cwd });
  const existing = sessions.find(
    (session) =>
      isLive(session) &&
      session.languageId === languageId &&
      session.owner !== undefined &&
      JSON.stringify(session.owner) === JSON.stringify(owner),
  );
  if (existing !== undefined) return existing;
  // An agent-started session uses Scient-managed Python when it is installed: it carries the
  // scientific packages, and the user's default stays theirs.
  const inventory = yield* scope.gateway.runtimeInventory();
  const managed = inventory.languages
    .find((language) => language.descriptor.languageId === languageId)
    ?.installations.find((installation) => installation.source === "managed");
  return yield* scope.gateway.startSession({
    cwd: scope.cwd,
    sessionId: ComputeSessionId.make(`agent-${NodeCrypto.randomUUID()}`),
    languageId,
    executable: managed?.problem === null ? managed.executable : null,
    owner,
  });
}, Effect.mapError(computeFailed));
