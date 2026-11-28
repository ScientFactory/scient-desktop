import { msg, useMessages } from "gt-react";
import { browserImportFailureMessage } from "@t3tools/client-runtime/contract-labels";
import {
  ACCOUNTS_PROTOCOL_2,
  BrowserImportFailureReason,
  BrowserProfileId,
  type EnvironmentId,
  type ProfileImportCause,
  type ProfileOperateResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { toastManager } from "~/components/ui/toast";
import type { MessageResolver } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { activityConversation } from "./activityConversation";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

/** Long enough to read the notice and press Undo; the operation keeps its Undo for the hour. */
const UNDO_NOTICE_MS = 30_000;

type Operation = NonNullable<ProfileOperateResult["operation"]>;

/** Not waiting on a store any more: what it did, or didn't, is known. */
export const settled = (operation: Operation) =>
  ![
    operation.server,
    operation.desktop,
    ...(operation.others ?? []).map(({ outcome }) => outcome),
  ].some((store) => store?.state === "pending");

/** The operation once every store is done, as its computer's Accounts records it. */
export function settledOperation(environmentId: EnvironmentId, operation: Operation) {
  if (settled(operation)) return Promise.resolve(operation);
  const atom = accountsState.snapshot({ environmentId, input: {} });
  return new Promise<Operation>((resolve) => {
    let stop = () => undefined as void;
    stop = appAtomRegistry.subscribe(
      atom,
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const now = result.value.profileOperations?.find(
          ({ operationId }) => operationId === operation.operationId,
        );
        if (!now || !settled(now)) return;
        queueMicrotask(() => stop());
        resolve(now);
      },
      { immediate: true },
    );
  });
}

/** What a notice says while the operation is still being done. */
function operationPendingTitle(
  operation: Operation,
  names: { readonly name: string; readonly into: string },
) {
  const { name, into } = names;
  switch (operation.kind) {
    case "remove":
      return m(msg("Removing {name}…", { name }));
    case "clear":
      return m(msg("Clearing {name}…", { name }));
    case "sign-out":
      return m(msg("Signing out of {site}…", { site: operation.site ?? "" }));
    case "copy":
      return m(msg("Copying {name} to {into}…", { name, into }));
    case "move":
      return m(msg("Moving {name} to {into}…", { name, into }));
    case "refresh":
      return m(msg("Refreshing {name}…", { name }));
    default:
      return m(msg("Merging {name} into {into}…", { name, into }));
  }
}

/** The line a notice and Recent changes show for an operation. */
export function operationTitle(
  operation: Operation,
  names: { readonly name: string; readonly into: string },
  resolve: MessageResolver = m,
) {
  const { name, into } = names;
  switch (operation.kind) {
    case "remove":
      return resolve(msg("Removed {name}", { name }));
    case "clear":
      return resolve(msg("Cleared {name}", { name }));
    case "sign-out":
      // Some cookie stayed, or a desktop didn't sign out: it says so (round 6e).
      return operationOutcome(operation, resolve).partly && !operation.stopped
        ? resolve(msg("Partly signed out of {site}", { site: operation.site ?? "" }))
        : resolve(msg("Signed out of {site}", { site: operation.site ?? "" }));
    case "copy":
      return resolve(msg("Copied {name} to {into}", { name, into }));
    case "move":
      return resolve(msg("Moved {name} to {into}", { name, into }));
    case "refresh":
      return resolve(msg("Refreshed {name}", { name }));
    default:
      return resolve(msg("Merged {name} into {into}", { name, into }));
  }
}

/**
 * Whether only part of it was done, and what to say: why it stopped, the sites left, cookies it
 * couldn't reach, cookies its Undo can't put back here (no protected store), or that part
 * didn't end.
 */
/** Accounts' own causes, each with the one thing to do; the browser's are translated with it. */
const IMPORT_CAUSES = {
  notLinked: msg("It isn't linked to a browser profile: import it from one again."),
  managedPolicy: msg("This computer's managed policy doesn't allow importing browser cookies."),
  passwordsUnreadable: msg(
    "The browser's passwords couldn't be read. Allow access if your computer asks, then try again.",
  ),
  passwordsNotSaved: msg("The passwords were read but couldn't be saved. Try again."),
  stopped: msg(
    "The profile or agent access changed meanwhile, so it stopped. What it brought in stays.",
  ),
} as const;
const isBrowserReason = (cause: ProfileImportCause): cause is BrowserImportFailureReason =>
  (BrowserImportFailureReason.literals as ReadonlyArray<string>).includes(cause);

/** Why an import or refresh failed, as the one thing to do about it (round 6d). */
const importCauseMessage = (cause: ProfileImportCause, resolve: MessageResolver = m) =>
  isBrowserReason(cause)
    ? browserImportFailureMessage(cause, resolve)
    : resolve(IMPORT_CAUSES[cause as keyof typeof IMPORT_CAUSES]);

export function operationOutcome(operation: Operation, resolve: MessageResolver = m) {
  // Every part: this computer's stores and each other desktop's jar, named (round 6e).
  const parts = [
    ...[operation.server, operation.desktop].flatMap((outcome) =>
      outcome ? [{ desktop: undefined as string | undefined, outcome }] : [],
    ),
    ...(operation.others ?? []).map(({ computer, outcome }) => ({
      desktop: computer.label as string | undefined,
      outcome,
    })),
  ];
  const stores = parts.map(({ outcome }) => outcome);
  const notCopied = [
    ...new Set([
      ...(operation.uncovered ?? []),
      ...stores.flatMap((store) => store.uncovered ?? []),
    ]),
  ];
  const failed = stores.some((store) => store.state === "failed");
  const cause = stores.find((store) => store.cause)?.cause;
  const passwords = stores.reduce<number | undefined>(
    (sum, store) => (store.passwords === undefined ? sum : (sum ?? 0) + store.passwords),
    undefined,
  );
  // What each desktop left: cookies it couldn't reach, and cookies its Undo can't put back.
  const left = parts.flatMap(({ desktop, outcome }) => [
    ...(outcome.leftBehind
      ? [
          desktop
            ? resolve(
                msg(
                  "{count, plural, one {# cookie} other {# cookies}} couldn't be signed out on {desktop}",
                  { count: outcome.leftBehind, desktop },
                ),
              )
            : resolve(
                msg("{count, plural, one {# cookie} other {# cookies}} couldn't be signed out", {
                  count: outcome.leftBehind,
                }),
              ),
        ]
      : []),
    ...(outcome.notRestorable
      ? [
          desktop
            ? resolve(
                msg(
                  "Undo can't put {count, plural, one {# cookie} other {# cookies}} back on {desktop}",
                  { count: outcome.notRestorable, desktop },
                ),
              )
            : resolve(
                msg(
                  "Undo can't put {count, plural, one {# cookie} other {# cookies}} back on this computer",
                  { count: outcome.notRestorable },
                ),
              ),
        ]
      : []),
  ]);
  const failedOn = parts.flatMap(({ desktop, outcome }) =>
    desktop && outcome.state === "failed" ? [desktop] : [],
  );
  return {
    partly: failed || notCopied.length > 0 || left.length > 0 || operation.stopped !== undefined,
    description: operation.stopped
      ? operation.stopped
      : cause
        ? importCauseMessage(cause, resolve)
        : notCopied.length
          ? resolve(msg("Not copied: {sites}", { sites: notCopied.slice(0, 5).join(", ") }))
          : left.length || failedOn.length
            ? [
                ...failedOn.map((desktop) => resolve(msg("Not done on {desktop}", { desktop }))),
                ...left,
              ].join(" · ")
            : failed
              ? resolve(msg("Partly done"))
              : passwords !== undefined
                ? resolve(
                    msg("{count, plural, one {# password} other {# passwords}} saved", {
                      count: passwords,
                    }),
                  )
                : undefined,
  };
}

/** Undo, then a word on what it kept: sign-ins made since stay where they were made. */
export async function undoAndTell(
  undo: (input: {
    readonly operationId: string;
  }) => Promise<{ readonly ok: true; readonly value: Operation } | { readonly ok: false }>,
  operationId: string,
) {
  const back = await undo({ operationId });
  const kept = back.ok ? (back.value.undone?.conflicts ?? []) : [];
  if (kept.length)
    toastManager.add({
      type: "info",
      title: m(msg("Kept the sign-ins made since: {names}", { names: kept.join(", ") })),
    });
}

/**
 * A profile's Remove, Clear and site sign-out as the person does them (round 6b, AMENDMENTS 57):
 * at once, with Undo in the notice, no confirmation. `undefined` from `run` means this computer's
 * Accounts predates it, and the caller does what it did before.
 */
export function useProfileOperations(environmentId: EnvironmentId) {
  const messages = useMessages();
  const operate = useAccountCommand(accountsState.operateProfile, environmentId);
  const undo = useAccountCommand(accountsState.undoProfile, environmentId);
  const supported = (useAccounts(environmentId).data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2;
  const refused = (result: ProfileOperateResult, name: string) => {
    const reason = result.refused!;
    const chats = (reason.threadIds ?? [])
      .map((threadId) => activityConversation({ threadId }, environmentId, messages))
      .filter((title): title is string => Boolean(title));
    toastManager.add({
      type: "error",
      title:
        reason.reason === "open-tabs"
          ? m(msg("Close {name}''s tabs first", { name }))
          : reason.reason === "signing-in"
            ? m(msg("A sign-in is under way in {name}", { name }))
            : reason.reason === "widens"
              ? m(msg("{name}''s sign-ins would reach further there", { name }))
              : reason.message,
      ...(chats.length ? { description: chats.join(" · ") } : {}),
    });
  };
  const run = async (
    kind: "remove" | "clear" | "sign-out" | "copy" | "move" | "merge",
    profile: { readonly id: string; readonly name: string },
    site?: string,
    into?: { readonly id: string; readonly name: string },
  ) => {
    if (!supported) return undefined;
    const done = await operate({
      operationId: randomUUID(),
      kind,
      profileId: BrowserProfileId.make(profile.id),
      ...(site ? { site } : {}),
      ...(into ? { into: BrowserProfileId.make(into.id) } : {}),
    });
    if (!done.ok) return false;
    if (done.value.refused || !done.value.operation) {
      refused(done.value, profile.name);
      return false;
    }
    const names = { name: profile.name, into: into?.name ?? "" };
    // While it is being done the notice says so; once it has ended, how it ended, with Undo
    // (round 6d). Never "done" before it is: Undo stays in Recent changes for its hour.
    const ended = (operation: Operation) => {
      const outcome = operationOutcome(operation);
      return {
        type: outcome.partly ? ("warning" as const) : ("success" as const),
        title: operationTitle(operation, names),
        ...(outcome.description ? { description: outcome.description } : {}),
        timeout: UNDO_NOTICE_MS,
        actionProps: {
          children: m(msg("Undo")),
          onClick: async () => {
            toastManager.close(id);
            await undoAndTell(undo, operation.operationId);
          },
        },
      };
    };
    const first = done.value.operation;
    const id: string = settled(first)
      ? toastManager.add(ended(first))
      : toastManager.add({
          type: "loading",
          title: operationPendingTitle(first, names),
          timeout: 0,
        });
    if (!settled(first))
      void settledOperation(environmentId, first).then((operation) =>
        toastManager.update(id, ended(operation)),
      );
    return true;
  };
  return { run, supported };
}
