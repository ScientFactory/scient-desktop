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

import type { PreviewAutomationStatus } from "@t3tools/contracts";

import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import {
  addConnector as addFor,
  controlConnector as controlFor,
  listConnectors as listFor,
  testConnector,
} from "../../extensions/ConnectorAgentControl.ts";
import { consumeAgentWorkspace } from "../../operations/AgentWorkspaceScope.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { previewInvoker } from "./broker.ts";
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

export const addConnector = Effect.fn("AccountsAgent.connectorAdd")(function* (
  input: Input<"scient_connector_add">,
) {
  const where = yield* workspace.pipe(Effect.option);
  return yield* addFor({
    from: input.from,
    workingFolder: Option.getOrUndefined(where)?.folder,
  }).pipe(Effect.mapError(toAccountsError));
});

/** Shows a sign-in page in this chat's browser; false when the chat has no browser. */
const openForUser = Effect.fn("AccountsAgent.openForUser")(function* (url: string) {
  const invocation = yield* AgentInvocationContext;
  if (!invocation.capabilities.has("preview")) return false;
  const invoke = previewInvoker(yield* PreviewAutomationBroker, invocation);
  return yield* invoke<PreviewAutomationStatus>("open", {
    url,
    open: true,
    reuseExistingTab: false,
  }).pipe(
    Effect.map((status) => status.tabId !== null),
    Effect.orElseSucceed(() => false),
  );
});

export const controlConnector = Effect.fn("AccountsAgent.connectorControl")(function* (
  input: Input<"scient_connector_control">,
) {
  const context = yield* Effect.context<AgentInvocationContext | PreviewAutomationBroker>();
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
    if (input.calls !== undefined || input.signIn !== undefined)
      return yield* new AccountsError({
        reason: "invalid-input",
        message: "calls and signIn need a folder: scient_connector_copy makes one.",
      });
    return yield* testConnector(input.connector).pipe(Effect.mapError(toAccountsError));
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
  const missing = saved.connector.local?.missing ?? [];
  const name = saved.connector.displayName;
  const serverName = saved.connector.serverName;
  return {
    connector: serverName,
    status: missing.length > 0 ? ("needs-setup" as const) : ("ready" as const),
    tools: saved.tools,
    missing,
    message:
      missing.length > 0
        ? `Saved ${name}, on for every project. It still needs ${missing.join(", ")}: call scient_connector_setup with {"connector":"${serverName}"}. Its tools reach new chats from the user's next message, as mcp__${serverName}__<tool>.`
        : `Saved ${name}, on for every project. Its tools reach new chats from the user's next message, as mcp__${serverName}__<tool>. The user can undo this on its page in Settings → Extensions.`,
  };
});
