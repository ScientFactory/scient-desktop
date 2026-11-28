// @effect-diagnostics nodeBuiltinImport:off -- Resolves an agent's folder against the chat's own folder.
/**
 * Agents make and fix local connectors in the chat's own folder; Scient checks and installs them.
 * The tools stay thin: they find the chat's folder and call the connector runtime.
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  AccountId,
  AccountsError,
  type ConnectorToolFailureClass,
  type ExtensionsError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { ThreadMcpStatusRegistry } from "../../../mcpApps/ThreadMcpStatusRegistry.ts";
import { PreviewManager } from "../../../preview/Manager.ts";
import {
  type AddAsks,
  addConnector as addFor,
  changeReport,
  controlConnector as controlFor,
  isScientConnector,
  listConnectors as listFor,
  testConnector,
} from "../../extensions/ConnectorAgentControl.ts";
import { consumeAgentWorkspace } from "../../operations/AgentWorkspaceScope.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { accountTokenRef } from "../AccountBoundRef.ts";
import { AccountsService } from "../AccountsService.ts";
import { askForAccountKey, askInCard, cardEndedNote } from "./accountAdd.ts";
import { personTimeLeft, withCardAllowance } from "./cardAllowance.ts";
import { accountSessionScope } from "./scope.ts";
import type { ScientAccountsToolkit } from "./tools.ts";

type Input<K extends keyof typeof ScientAccountsToolkit.tools> = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)[K]["parametersSchema"]
>;

const FAILURE_CLASS = {
  "not-found": "not_found",
  "invalid-input": "invalid_input",
  unreachable: "unreachable",
  "not-an-mcp-server": "not_an_mcp_server",
  "sign-in-failed": "sign_in_failed",
  "registration-unsupported": "registration_unsupported",
  "limit-reached": "limit_reached",
  "state-unavailable": "state_unavailable",
  unsupported: "unsupported",
  "provider-rejected": "provider_rejected",
} as const satisfies Record<ExtensionsError["reason"], ConnectorToolFailureClass>;

export const toAccountsError = (error: ExtensionsError) =>
  new AccountsError({
    reason:
      error.reason === "invalid-input" || error.reason === "not-found"
        ? "invalid-input"
        : "unavailable",
    message: error.message,
    failureClass: FAILURE_CLASS[error.reason],
  });

const runtime = Effect.gen(function* () {
  // Looked up here, so the Accounts tools do not need Extensions wherever they are built.
  const found = yield* Effect.serviceOption(ConnectorRuntime);
  if (Option.isNone(found))
    return yield* new AccountsError({
      reason: "unavailable",
      message: "Connectors are unavailable here.",
    });
  return found.value;
});

/** The chat's folder, where copies go and relative folders are read from. */
const workspace = Effect.gen(function* () {
  const resolved = yield* consumeAgentWorkspace();
  const scope = yield* McpInvocationContext;
  return {
    folder: resolved.binding.canonicalRoot,
    location: {
      providerInstanceId: scope.thread?.providerInstanceId,
      projectId: resolved.binding.hostProjectId,
      worktreePath: resolved.binding.canonicalRoot,
    },
  };
}).pipe(
  Effect.mapError(
    () =>
      new AccountsError({
        reason: "unavailable",
        message: "Connectors are made in a chat that has a project folder.",
      }),
  ),
);

/** The chat's project, so an agent's test uses only the sign-ins and keys that project may use. */
const callerLocation = Effect.gen(function* () {
  const where = yield* workspace.pipe(Effect.option);
  if (Option.isSome(where)) return where.value.location;
  const { projectId } = yield* accountSessionScope();
  const scope = yield* McpInvocationContext;
  return { projectId, worktreePath: null, providerInstanceId: scope.thread?.providerInstanceId };
});

const folderIn = (base: string, folder: string) =>
  NodePath.isAbsolute(folder) ? NodePath.normalize(folder) : NodePath.resolve(base, folder);

export const copyConnector = Effect.fn("AccountsAgent.connectorCopy")(function* (
  input: Input<"scient_connector_copy">,
) {
  const where = yield* workspace;
  const connectors = yield* runtime;
  const { threadId, providerInstanceId } = yield* AgentInvocationContext;
  return yield* connectors
    .copyForAgent({
      workingFolder: where.folder,
      connector: input.connector,
      name: input.name,
      providerInstanceId,
      owner: threadId,
    })
    .pipe(Effect.mapError(toAccountsError));
});

export const listConnectors = Effect.fn("AccountsAgent.connectorList")(function* (
  input: Input<"scient_connector_list">,
) {
  const scope = yield* AgentInvocationContext;
  return yield* listFor({ query: input.query, providerInstanceId: scope.providerInstanceId }).pipe(
    Effect.mapError(toAccountsError),
  );
});

/** A key or sign-in app asked in the private card; what went wrong in the user's words. */
const keptOr = <A>(asked: Effect.Effect<A | { readonly problem: string }, AccountsError, never>) =>
  asked.pipe(Effect.catch((error) => Effect.succeed({ problem: error.message })));

const cardProblem = (status: string) =>
  status === "declined" || status === "cancelled" || status === "timed_out"
    ? cardEndedNote(status)
    : `the card ended (${status}).`;

/** The add's private cards: the key goes to Accounts, a sign-in app to the connector itself. */
const addAsks = Effect.gen(function* () {
  const scope = yield* accountSessionScope();
  const context = yield* Effect.context<
    AccountsService | McpInvocationContext | OrchestratorMcpService | SecretRequests
  >();
  return {
    key: (request) =>
      keptOr(
        Effect.gen(function* () {
          const asked = yield* askForAccountKey(scope, {
            name: request.name,
            reason: request.reason,
            sites: [request.site],
            ...(request.header === undefined ? {} : { header: request.header }),
          });
          if (asked.status === "saved") return { secretRef: accountTokenRef(asked.accountId) };
          return {
            problem:
              asked.status === "turned_off"
                ? "the user turned that key off in Settings → Accounts & secrets."
                : asked.status === "linked"
                  ? "its key lives in the user's password manager; they update it there."
                  : asked.status === "unavailable"
                    ? asked.message
                    : cardProblem(asked.status),
          };
        }).pipe(Effect.provide(context)),
      ),
    signInApp: (request) =>
      keptOr(
        Effect.gen(function* () {
          const notKept = "The sign-in app was not kept. Ask the user to enter it again.";
          const register =
            request.redirectUri === undefined
              ? ""
              : ` Its redirect address must be ${request.redirectUri}.`;
          const id = yield* askInCard(scope, {
            label: `${request.name} client ID`,
            reason: `${request.name} signs in through the user's own app.${register}`,
            notKept,
          });
          if (id.status !== "saved") return { problem: cardProblem(id.status) };
          // The connector keeps these as it adds itself; the card's value is in its hands now.
          yield* (yield* AccountsService).recordCard(id.requestId, "saved");
          const secret = yield* askInCard(scope, {
            label: `${request.name} client secret`,
            reason: `Skip this if the app has no client secret.`,
            notKept,
          });
          // Declining is the user's "no secret"; a card that timed out or closed is no answer.
          if (secret.status === "timed_out" || secret.status === "cancelled")
            return { problem: cardProblem(secret.status) };
          if (secret.status === "saved")
            yield* (yield* AccountsService).recordCard(secret.requestId, "saved");
          return {
            clientId: id.value,
            ...(secret.status === "saved" ? { clientSecret: secret.value } : {}),
          };
        }).pipe(Effect.provide(context)),
      ),
  } satisfies AddAsks;
});

export const addConnector = Effect.fn("AccountsAgent.connectorAdd")(function* (
  input: Input<"scient_connector_add">,
) {
  const where = yield* workspace.pipe(Effect.option);
  return yield* addFor({
    from: input.from,
    workingFolder: Option.getOrUndefined(where)?.folder,
    location: yield* callerLocation,
    asks: yield* addAsks,
  }).pipe(Effect.mapError(toAccountsError));
}, withCardAllowance);

/**
 * Opens a sign-in page in this chat's browser as the user's own tab, ready for them: no agent
 * holds it, so there is nothing to take over. False when the chat has no browser.
 */
export const openForUser = Effect.fn("AccountsAgent.openForUser")(function* (url: string) {
  const invocation = yield* AgentInvocationContext;
  const previews = yield* Effect.serviceOption(PreviewManager);
  if (!invocation.capabilities.has("preview") || Option.isNone(previews)) return undefined;
  return yield* previews.value
    .open({ threadId: invocation.threadId, url, runtime: "server", reveal: true })
    .pipe(
      Effect.map((snapshot) => snapshot.tabId),
      Effect.orElseSucceed(() => undefined),
    );
});

const SIGN_IN_LOOK_MS = 2_000;

/**
 * The person's sign-in to a connector in the hand-off card on its tab, waited on for the call's
 * time: signed in or failed as that sign-in's own callback says, cancelled from the card, or
 * timed out.
 */
const waitForConnectorSignIn = Effect.fn("AccountsAgent.connectorSignInWait")(function* (
  connector: string,
  tabId: string,
  url: string,
  ended: Fiber.Fiber<"connected" | "failed">,
) {
  const accounts = yield* AccountsService;
  const invocation = yield* AgentInvocationContext;
  const previews = yield* Effect.serviceOption(PreviewManager);
  const left = yield* personTimeLeft;
  const startedAt = yield* Clock.currentTimeMillis;
  const handoffId = `connector-${NodeCrypto.randomUUID()}`;
  yield* accounts.setHandoff(
    {
      handoffId,
      threadId: invocation.threadId,
      accountId: AccountId.make(
        `acc_connector-${NodeCrypto.createHash("sha256").update(connector).digest("hex").slice(0, 32)}`,
      ),
      accountName: connector,
      site: URL.canParse(url) ? new URL(url).host : connector,
      tabId,
      kind: "other",
      reason: `Sign in to ${connector} here.`,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt + Math.max(left, 0))),
    },
    // "Open browser" shows the sign-in's own tab.
    Option.isSome(previews)
      ? previews.value
          .requestReveal({ threadId: invocation.threadId, tabId, force: true })
          .pipe(Effect.ignore)
      : Effect.void,
  );
  return yield* Effect.gen(function* () {
    while ((yield* Clock.currentTimeMillis) - startedAt < left) {
      if (yield* accounts.handoffCancelled(handoffId)) return "cancelled" as const;
      const done = ended.pollUnsafe();
      if (done !== undefined && Exit.isSuccess(done))
        return done.value === "connected" ? ("signed-in" as const) : ("failed" as const);
      yield* Effect.sleep(SIGN_IN_LOOK_MS);
    }
    return "timed_out" as const;
  }).pipe(
    Effect.ensuring(accounts.removeHandoff(handoffId)),
    Effect.ensuring(Fiber.interrupt(ended)),
  );
});

/**
 * A sign-in for one of the agent's own MCP servers (not a Scient connector) that this chat
 * reports needs one: the session that reported it puts a Sign in row in the chat.
 */
export const agentServerSignIn = Effect.fn("AccountsAgent.agentServerSignIn")(function* (
  name: string,
) {
  const registry = yield* Effect.serviceOption(ThreadMcpStatusRegistry);
  if (Option.isNone(registry)) return undefined;
  const invocation = yield* AgentInvocationContext;
  const outcome = yield* registry.value.requestSignIn({
    threadId: invocation.threadId,
    server: name,
  });
  if (outcome._tag === "none") return undefined;
  const server = outcome.displayName;
  const reply = (status: "ready" | "needs-sign-in" | "error", message: string) => ({
    connector: server,
    status,
    message,
  });
  switch (outcome._tag) {
    case "shown":
      return reply(
        "needs-sign-in",
        `The chat now shows the user a Sign in row for ${server}. Tell them in one short sentence, carry on with whatever does not need it, and do not ask again until they send another message. Its tools come once they finish.`,
      );
    case "signed-in":
      return reply("ready", `${server} is connected now: call its tools.`);
    case "checking":
      return reply(
        "needs-sign-in",
        `${server} is still connecting. Carry on with whatever does not need it and ask again later in this turn if you still need it.`,
      );
    case "not-available":
      return reply(
        "error",
        `${server} is turned off or failed to start, so a sign-in would not help. Tell the user in one short sentence that it is unavailable, and carry on with whatever does not need it.`,
      );
    case "claudeai":
      return reply(
        "needs-sign-in",
        `${server} is a claude.ai connector: the user signs in to it in their claude.ai connector settings. Tell them in one short sentence and carry on with whatever does not need it.`,
      );
    case "inactive":
      return reply(
        "needs-sign-in",
        `${server}'s last status came from an agent session that has ended, so no sign-in can be shown now. Tell the user in one short sentence that, if it still needs one, they can sign in from the plug button above this chat after their next message, and carry on with whatever does not need it.`,
      );
    case "card":
      return reply(
        "needs-sign-in",
        `${server} needs the user's sign-in, which they start from the plug button above this chat, under "Optional servers not signed in". Tell them in one short sentence and carry on with whatever does not need it.`,
      );
  }
});

export const controlConnector = Effect.fn("AccountsAgent.connectorControl")(function* (
  input: Input<"scient_connector_control">,
) {
  // A Scient connector of the same name keeps its own sign-in.
  if (input.action === "sign-in" && !(yield* isScientConnector(input.connector))) {
    const agentServer = yield* agentServerSignIn(input.connector);
    if (agentServer !== undefined) return agentServer;
  }
  const context = yield* Effect.context<AgentInvocationContext>();
  let opened: { readonly tabId: string; readonly url: string } | undefined;
  const controlled = yield* controlFor(
    input,
    (url) =>
      openForUser(url).pipe(
        Effect.provide(context),
        Effect.map((tabId) => {
          if (tabId !== undefined) opened = { tabId, url };
          return tabId !== undefined;
        }),
      ),
    yield* callerLocation,
  ).pipe(Effect.mapError(toAccountsError));
  // This flow alone, by the OAuth state its address carries: another chat's sign-in of the same
  // connector, or one from Settings, ends its own card.
  const state =
    opened !== undefined && URL.canParse(opened.url)
      ? new URL(opened.url).searchParams.get("state")
      : null;
  const connectors = yield* runtime.pipe(Effect.option);
  if (opened === undefined || state === null || Option.isNone(connectors)) return controlled;
  const signInEnded = connectors.value.signInEnded;
  if (signInEnded === undefined) return controlled;
  const ended = yield* Effect.forkChild(signInEnded(state));
  const outcome = yield* waitForConnectorSignIn(input.connector, opened.tabId, opened.url, ended);
  return {
    ...controlled,
    // The status this flow left, not the one before the sign-in.
    ...(outcome === "signed-in"
      ? { status: "ready" as const }
      : outcome === "failed"
        ? { status: "needs-sign-in" as const }
        : {}),
    message:
      outcome === "signed-in"
        ? `Signed in to ${input.connector}. scient_connector_check {"connector":"${input.connector}"} lists its tools.`
        : outcome === "failed"
          ? `The sign-in to ${input.connector} didn't go through. Tell the user in one short sentence.`
          : outcome === "cancelled"
            ? `The user cancelled the sign-in to ${input.connector}. Don't open it again this turn unless they ask.`
            : `The sign-in to ${input.connector} is still open for the user, but this call's time ran out. Ask them to finish it, then scient_connector_check {"connector":"${input.connector}"}.`,
  };
}, withCardAllowance);

export const checkConnector = Effect.fn("AccountsAgent.connectorCheck")(function* (
  input: Input<"scient_connector_check">,
) {
  if (input.folder === undefined) {
    if (input.connector === undefined)
      return yield* new AccountsError({
        reason: "invalid-input",
        message: "Give folder (a copy to check) or connector (an installed one to test).",
      });
    if (input.signIn !== undefined)
      return yield* new AccountsError({
        reason: "invalid-input",
        message: "signIn needs a folder: scient_connector_copy makes one.",
      });
    return yield* testConnector(input.connector, yield* callerLocation, input.calls).pipe(
      Effect.mapError(toAccountsError),
    );
  }
  const folder = input.folder;
  const where = yield* workspace;
  const connectors = yield* runtime;
  return yield* connectors
    .checkFolder(
      {
        folder: folderIn(where.folder, folder),
        connector: input.connector,
        signIn: input.signIn,
        ...(input.calls === undefined ? {} : { calls: input.calls }),
      },
      where.location,
    )
    .pipe(Effect.mapError(toAccountsError));
});

export const saveConnector = Effect.fn("AccountsAgent.connectorSave")(function* (
  input: Input<"scient_connector_save">,
) {
  const where = yield* workspace;
  const connectors = yield* runtime;
  const saved = yield* connectors
    .saveFolder(
      { folder: folderIn(where.folder, input.folder), connector: input.connector },
      where.location,
    )
    .pipe(Effect.mapError(toAccountsError));
  return changeReport("Saved", saved.connector, saved.tools);
});
