// @effect-diagnostics nodeBuiltinImport:off -- Resolves an agent's folder against the chat's own folder.
/**
 * Agents make and fix local connectors in the chat's own folder; Scient checks and installs them.
 * The tools stay thin: they find the chat's folder and call the connector runtime.
 */
import * as NodePath from "node:path";

import { AccountsError, type ExtensionsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { PreviewManager } from "../../../preview/Manager.ts";
import {
  type AddAsks,
  addConnector as addFor,
  changeReport,
  controlConnector as controlFor,
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
import { askForAccountKey, askInCard } from "./accountAdd.ts";
import { accountSessionScope } from "./scope.ts";
import type { ScientAccountsToolkit } from "./tools.ts";

type Input<K extends keyof typeof ScientAccountsToolkit.tools> = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)[K]["parametersSchema"]
>;

const toAccountsError = (error: ExtensionsError) =>
  new AccountsError({
    reason:
      error.reason === "invalid-input" || error.reason === "not-found"
        ? "invalid-input"
        : "unavailable",
    message: error.message,
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
const workspace = consumeAgentWorkspace().pipe(
  Effect.map((resolved) => ({
    folder: resolved.binding.canonicalRoot,
    location: {
      projectId: resolved.binding.hostProjectId,
      worktreePath: resolved.binding.canonicalRoot,
    },
  })),
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
  return projectId === undefined ? undefined : { projectId, worktreePath: null };
});

const folderIn = (base: string, folder: string) =>
  NodePath.isAbsolute(folder) ? NodePath.normalize(folder) : NodePath.resolve(base, folder);

export const copyConnector = Effect.fn("AccountsAgent.connectorCopy")(function* (
  input: Input<"scient_connector_copy">,
) {
  const where = yield* workspace;
  const connectors = yield* runtime;
  return yield* connectors
    .copyForAgent({ workingFolder: where.folder, connector: input.connector, name: input.name })
    .pipe(Effect.mapError(toAccountsError));
});

export const listConnectors = Effect.fn("AccountsAgent.connectorList")(function* (
  input: Input<"scient_connector_list">,
) {
  return yield* listFor({ query: input.query }).pipe(Effect.mapError(toAccountsError));
});

/** A key or sign-in app asked in the private card; what went wrong in the user's words. */
const keptOr = <A>(asked: Effect.Effect<A | { readonly problem: string }, AccountsError, never>) =>
  asked.pipe(Effect.catch((error) => Effect.succeed({ problem: error.message })));

const cardProblem = (status: string) =>
  status === "declined" ? "the user did not enter it." : `the card ended (${status}).`;

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
          if (asked.status === "saved" || asked.status === "exists")
            return { secretRef: accountTokenRef(asked.accountId) };
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
          const secret = yield* askInCard(scope, {
            label: `${request.name} client secret`,
            reason: `Skip this if the app has no client secret.`,
            notKept,
          });
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
});

/**
 * Opens a sign-in page in this chat's browser as the user's own tab, ready for them: no agent
 * holds it, so there is nothing to take over. False when the chat has no browser.
 */
export const openForUser = Effect.fn("AccountsAgent.openForUser")(function* (url: string) {
  const invocation = yield* AgentInvocationContext;
  const previews = yield* Effect.serviceOption(PreviewManager);
  if (!invocation.capabilities.has("preview") || Option.isNone(previews)) return false;
  return yield* previews.value
    .open({ threadId: invocation.threadId, url, runtime: "server", reveal: true })
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
});

export const controlConnector = Effect.fn("AccountsAgent.connectorControl")(function* (
  input: Input<"scient_connector_control">,
) {
  const context = yield* Effect.context<AgentInvocationContext>();
  return yield* controlFor(input, (url) => openForUser(url).pipe(Effect.provide(context))).pipe(
    Effect.mapError(toAccountsError),
  );
});

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
