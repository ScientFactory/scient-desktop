import {
  type ProviderInstanceId,
  ProviderMcpSignInError,
  type ProviderMcpSignInCompleteInput,
  type ProviderMcpSignInCompleteResult,
  type ProviderMcpSignInStartInput,
  type ProviderMcpSignInStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMcpStatusRegistry from "./ThreadMcpStatusRegistry.ts";
// SCIENT-FORK:START — a chat sign-in refreshes the instance's Extensions inventory.
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
// SCIENT-FORK:END

/**
 * Signs an agent's MCP server in through the session that reported it needs
 * one. Agents keep the credential themselves, so this never starts a session.
 */
export class McpSignIn extends Context.Service<
  McpSignIn,
  {
    readonly start: (
      input: ProviderMcpSignInStartInput,
    ) => Effect.Effect<ProviderMcpSignInStartResult, ProviderMcpSignInError>;
    readonly complete: (
      input: ProviderMcpSignInCompleteInput,
    ) => Effect.Effect<ProviderMcpSignInCompleteResult, ProviderMcpSignInError>;
  }
>()("t3/mcpApps/McpSignIn") {}

const isSignInError = Schema.is(ProviderMcpSignInError);

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threadMcpStatus = yield* Effect.serviceOption(
    ThreadMcpStatusRegistry.ThreadMcpStatusRegistry,
  );
  const markSignedIn = (input: ProviderMcpSignInStartInput) =>
    Option.isSome(threadMcpStatus)
      ? threadMcpStatus.value.markSignInCompleted({
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          server: input.server,
        })
      : Effect.void;
  // SCIENT-FORK:START — the agent keeps the new credential; re-read the servers it lists.
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serviceScope = yield* Effect.scope;
  const refreshInventory = (providerThread: { readonly providerInstanceId: ProviderInstanceId }) =>
    providerRegistry
      .refreshInstance(providerThread.providerInstanceId)
      .pipe(Effect.ignore, Effect.forkIn(serviceScope), Effect.asVoid);
  // SCIENT-FORK:END

  const fail = (server: string, detail: string) => new ProviderMcpSignInError({ server, detail });
  const stopped = (server: string) =>
    fail(server, "The agent session has ended. Send a message, then sign in again.");

  const resolve = Effect.fn("McpSignIn.resolve")(function* (input: ProviderMcpSignInStartInput) {
    const projection = yield* threadManagement.getThreadRecords(input.threadId, [
      "providerThreads",
    ]);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === input.providerThreadId,
    );
    if (providerThread?.providerSessionId == null) return yield* stopped(input.server);
    const runtime = Option.getOrUndefined(
      yield* providerSessions.get(providerThread.providerSessionId),
    );
    if (runtime === undefined) return yield* stopped(input.server);
    if (runtime.mcpSignIn === undefined) {
      // SCIENT-FORK: user-visible text names Scient.
      return yield* fail(input.server, "This agent can't sign MCP servers in from Scient.");
    }
    return { providerThread, mcpSignIn: runtime.mcpSignIn };
  });

  /** Adapter and lookup failures can echo URLs or tokens, so callers see only a generic line. */
  const toSignInError = (input: ProviderMcpSignInStartInput, detail: string) => (cause: unknown) =>
    isSignInError(cause)
      ? Effect.fail(cause)
      : Predicate.isTagged(cause, "ProviderAdapterSessionStoppedError")
        ? Effect.fail(stopped(input.server))
        : Effect.logWarning("mcp-sign-in.failed", {
            threadId: input.threadId,
            server: input.server,
            cause: Predicate.hasProperty(cause, "_tag") ? cause._tag : "unknown",
          }).pipe(Effect.andThen(Effect.fail(fail(input.server, detail))));

  const start = Effect.fn("McpSignIn.start")(
    function* (input: ProviderMcpSignInStartInput) {
      const { providerThread, mcpSignIn } = yield* resolve(input);
      const { authorizationUrl } = yield* mcpSignIn.start({
        providerThread,
        server: input.server,
      });
      if (authorizationUrl === null) {
        yield* markSignedIn(input);
        // SCIENT-FORK: see refreshInventory.
        yield* refreshInventory(providerThread);
      }
      return {
        authorizationUrl,
        signedInAt: authorizationUrl === null ? DateTime.formatIso(yield* DateTime.now) : null,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch(toSignInError(input, `Couldn't start the sign-in to ${input.server}.`)),
      ),
  );

  const complete = Effect.fn("McpSignIn.complete")(
    function* (input: ProviderMcpSignInCompleteInput) {
      const { providerThread, mcpSignIn } = yield* resolve(input);
      yield* mcpSignIn.complete({
        providerThread,
        server: input.server,
        callbackUrl: input.callbackUrl,
      });
      yield* markSignedIn(input);
      // SCIENT-FORK: see refreshInventory.
      yield* refreshInventory(providerThread);
      return { signedInAt: DateTime.formatIso(yield* DateTime.now) };
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch(toSignInError(input, `Couldn't finish the sign-in to ${input.server}.`)),
      ),
  );

  return McpSignIn.of({ start, complete });
});

export const layer = Layer.effect(McpSignIn, make);
