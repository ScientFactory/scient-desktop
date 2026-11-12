/**
 * A local connector's missing setup, asked in the conversation: plain answers the agent got from
 * the user in chat, and keys through Accounts' private card, linked to the connector.
 */
import { AccountsError, type LocalKeyInput } from "@t3tools/contracts";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import { ConnectorRuntime } from "../../extensions/ExtensionsServices.ts";
import { accountTokenRef } from "../AccountBoundRef.ts";
import { AccountsService } from "../AccountsService.ts";
import { askForAccountKey } from "./accountAdd.ts";
import { authorize } from "./accountUse.ts";
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
      name: field.title.toLowerCase().includes(connector.displayName.trim().toLowerCase())
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
  // The site it signs in to: a sign-in the agent named, the only one saved for the site, or a
  // request to add one. The agent's use of it is checked like any account use.
  let signIn: string | undefined;
  const asked = local.signIn;
  if (asked !== undefined && (asked.state !== "linked" || input.signIn !== undefined)) {
    const host = URL.canParse(asked.site) ? new URL(asked.site).host : asked.site;
    const fitting = session.accounts.filter(
      (account) =>
        account.details.kind === "website" && anySiteMatches(account.details.sites, asked.site),
    );
    const wanted = input.signIn?.trim().toLowerCase();
    const chosen =
      wanted === undefined
        ? fitting.length === 1
          ? fitting[0]
          : undefined
        : fitting.find(
            (account) =>
              account.accountId === input.signIn?.trim() || account.name.toLowerCase() === wanted,
          );
    if (chosen !== undefined) {
      yield* authorize(scope, { type: "account", accountId: chosen.accountId }, "browser-session");
      signIn = chosen.accountId;
    } else if (asked.state === "needs-user") {
      missing.push(
        `the sign-in to ${host}: the site needs the user to sign in themselves. Ask them to press Sign in on the connector's page in Settings → Extensions`,
      );
    } else if (asked.state === "missing") {
      missing.push(
        fitting.length === 0
          ? `a sign-in to ${host}: call scient_account_add with {"kind":"website","site":"${asked.site}"} so the user signs in, then call this again`
          : `a sign-in to ${host}: pass signIn with one of ${fitting.map((account) => account.name).join(", ")}`,
      );
    }
  }
  if (Object.keys(settings).length > 0 || Object.keys(keys).length > 0 || signIn !== undefined) {
    yield* runtime
      .update({
        connectorId: connector.connectorId,
        localSetup: { settings, keys, ...(signIn === undefined ? {} : { signIn }) },
      })
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
