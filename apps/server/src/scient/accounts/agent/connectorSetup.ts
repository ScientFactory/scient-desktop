/**
 * A local connector's missing setup, asked in the conversation: plain answers the agent got from
 * the user in chat, and keys through Accounts' private card, linked to the connector.
 */
import { AccountsError, type LocalKeyInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { accountTokenRef } from "../AccountBoundRef.ts";
import { AccountsService } from "../AccountsService.ts";
import { askForAccountKey } from "./accountAdd.ts";
import { accountSessionScope } from "./scope.ts";
import type { ScientAccountsToolkit } from "./tools.ts";

type Input = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)["scient_connector_setup"]["parametersSchema"]
>;

const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const setUpConnector = Effect.fn("AccountsAgent.connectorSetup")(function* (input: Input) {
  const scope = yield* accountSessionScope();
  // Looked up here, so the Accounts tools do not need Extensions wherever they are built.
  const found = yield* Effect.serviceOption(ConnectorRuntime);
  if (Option.isNone(found)) return yield* unavailable("Connectors are unavailable here.");
  const runtime = found.value;
  const inventory = yield* runtime.list();
  const connector = inventory.connectors.find(
    (item) =>
      item.local !== undefined &&
      (item.serverName === input.connector || same(item.displayName, input.connector)),
  );
  const local = connector?.local;
  if (connector === undefined || local === undefined) {
    return yield* new AccountsError({
      reason: "invalid-input",
      message: `No local connector is named ${input.connector}.`,
    });
  }
  const fieldFor = (name: string) =>
    local.setup.find(({ field }) => field.key === name || same(field.title, name))?.field;

  const settings: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(input.settings ?? {})) {
    const field = fieldFor(name);
    if (field === undefined || field.sensitive) {
      return yield* new AccountsError({
        reason: "invalid-input",
        message: `${connector.displayName} has no plain setting named ${name}. Keys are asked in a private card, never passed here.`,
      });
    }
    settings[field.key] = value;
  }

  const session = yield* (yield* AccountsService).forSession(scope);
  const keys: Record<string, LocalKeyInput> = {};
  const missing: string[] = [];
  for (const { field, value, account } of local.setup) {
    if (!field.sensitive) {
      if (field.required && value === undefined && settings[field.key] === undefined) {
        missing.push(`${field.title}: ask the user, then pass it in settings as "${field.key}"`);
      }
      continue;
    }
    const replace = (input.replaceKeys ?? []).some(
      (name) => name === field.key || same(name, field.title),
    );
    if (!replace && (account !== undefined || !field.required)) continue;
    const current =
      account === undefined ? undefined : session.accounts.find((item) => item.name === account);
    const asked = yield* askForAccountKey(scope, {
      name: same(field.title, connector.displayName)
        ? field.title
        : `${connector.displayName} ${field.title}`,
      reason: field.description ?? `${connector.displayName} needs it to run.`,
      ...(field.envName !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(field.envName)
        ? { envName: field.envName }
        : {}),
      ...(replace && current !== undefined ? { accountId: current.accountId } : {}),
    });
    if (asked.status === "saved" || asked.status === "exists") {
      keys[field.key] = { type: "account", ref: accountTokenRef(asked.accountId) };
    } else {
      missing.push(
        asked.status === "turned_off"
          ? `${field.title}: the user turned that key off in Settings → Accounts & secrets`
          : asked.status === "linked"
            ? `${field.title}: its key lives in the user's password manager; they update it there`
            : asked.status === "unavailable"
              ? `${field.title}: ${asked.message}`
              : `${field.title}: the user did not enter it`,
      );
    }
  }
  if (Object.keys(settings).length > 0 || Object.keys(keys).length > 0) {
    yield* runtime
      .update({ connectorId: connector.connectorId, localSetup: { settings, keys } })
      .pipe(Effect.mapError((error) => unavailable(error.message)));
  }
  return missing.length > 0
    ? {
        status: "needs" as const,
        missing,
        message: `${connector.displayName} still needs: ${missing.join("; ")}.`,
      }
    : {
        status: "ready" as const,
        missing,
        message: `${connector.displayName} is set up and restarted. Call its tool again.`,
      };
});
