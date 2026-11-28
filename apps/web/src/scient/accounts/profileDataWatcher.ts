import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountsSnapshot,
  type EnvironmentId,
  type ProfileOperation,
  type ProfileStoreOutcome,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { accountsState } from "./accountsState";
import { refreshFromLink } from "./profileRefresh";

const PURGED_KEY = "scient.accounts.purged-profile-data";

const purgedHere = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PURGED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
const markPurged = (key: string) => {
  try {
    const keys = [...purgedHere(), key].slice(-500);
    localStorage.setItem(PURGED_KEY, JSON.stringify(keys));
  } catch {
    // Purged again next time: emptying an empty partition changes nothing.
  }
};

/** A profile made on this desktop's behalf joins the list the person sees, once. */
const adopt = (profileId: string, name: string) =>
  persistClientSettingsUpdate((current) =>
    current.browserProfiles.some((profile) => profile.id === profileId)
      ? current
      : {
          ...current,
          browserProfiles: [
            ...current.browserProfiles,
            { id: profileId, name, kind: "persistent" },
          ],
        },
  ).then(() => undefined);

/**
 * The generations its computer's Accounts has authorized for deletion: a removed profile's every
 * one, and each left behind, once marked purged there. This desktop's clock decides nothing, so an
 * Undo its computer still allows never finds its data gone.
 */
function dueGenerations(record: AccountsSnapshot["profiles"][number]): ReadonlyArray<number> {
  if (record.removed?.purgedAt)
    return [
      ...new Set([
        record.generation ?? 0,
        ...(record.retained ?? []).map(({ generation }) => generation),
      ]),
    ];
  return (record.retained ?? []).flatMap(({ generation, purgedAt }) =>
    purgedAt ? [generation] : [],
  );
}

/** Whether any part of an operation, or of its Undo, is still being carried out. */
const underWay = (operation: ProfileOperation) =>
  [
    operation.server,
    operation.desktop,
    ...(operation.others ?? []).map(({ outcome }) => outcome),
    operation.undone?.server,
    operation.undone?.desktop,
    ...(operation.undone?.others ?? []).map(({ outcome }) => outcome),
  ].some((part) => part?.state === "pending");

/**
 * Round 6b, in the window that does Accounts' background work: this desktop follows what a
 * computer's Accounts decided for its profiles. Each profile opens in the generation Clear left it
 * in; a sign-out's or its Undo's part in this desktop's partitions is carried out and reported; and
 * what the Undo hour no longer covers is emptied, a removed profile also leaving this list.
 */
export function watchProfileData(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  /** This desktop's id: an import by source runs only on the desktop that holds it. */
  thisComputer: () => string | undefined = () => undefined,
) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.setProfileGenerations) return () => undefined;
  const atom = accountsState.snapshot({ environmentId, input: {} });
  const started = new Set<string>();
  let pushed = "";
  let deadlinesPushed = "";
  const claim = (operationId: string, phase: "do" | "undo") => {
    const computer = thisComputer();
    return runAtomCommand(
      registry,
      accountsState.claimProfile,
      { environmentId, input: { operationId, phase, ...(computer ? { computer } : {}) } },
      { reportFailure: false },
    )
      .then((result) => result._tag === "Success" && result.value.ok)
      .catch(() => false);
  };
  const report = (
    operationId: string,
    phase: "do" | "undo",
    outcome: ProfileStoreOutcome,
    computer?: string,
  ) =>
    runAtomCommand(
      registry,
      accountsState.profileStoreDone,
      { environmentId, input: { operationId, phase, outcome, ...(computer ? { computer } : {}) } },
      { reportFailure: false },
    )
      .then(() => window.dispatchEvent(new Event("scient-accounts-session-changed")))
      .catch(() => undefined);
  const follow = (snapshot: AccountsSnapshot) => {
    const generations = Object.fromEntries(
      snapshot.profiles.flatMap((record) =>
        record.generation ? [[record.profileId, record.generation] as const] : [],
      ),
    );
    const key = JSON.stringify(generations);
    if (key !== pushed) {
      pushed = key;
      void bridge.setProfileGenerations?.(generations, environmentId).catch(() => {
        pushed = "";
      });
    }
    // Each receipt's Undo deadline, or none while any part is still under way: this desktop lets
    // go of what it kept for an Undo only past it, never by the age of its file (round 6e).
    const deadlines = Object.fromEntries(
      (snapshot.profileOperations ?? []).map((operation) => [
        operation.operationId,
        underWay(operation) ? null : operation.until,
      ]),
    );
    const deadlinesKey = JSON.stringify(deadlines);
    if (bridge.setUndoDeadlines && deadlinesKey !== deadlinesPushed && deadlinesKey !== "{}") {
      deadlinesPushed = deadlinesKey;
      void bridge.setUndoDeadlines(deadlines).then(
        (done) => done || (deadlinesPushed = ""),
        () => (deadlinesPushed = ""),
      );
    }
    for (const operation of snapshot.profileOperations ?? []) {
      const { operationId, profileId, site } = operation;
      // Its writes go into the data it was done in, whatever Clear did since (round 6d).
      const at = {
        ...(operation.generation === undefined ? {} : { generation: operation.generation }),
        ...(operation.intoGeneration === undefined
          ? {}
          : { intoGeneration: operation.intoGeneration }),
      };
      // An import by source belongs to the desktop that holds the browser, wherever asked.
      const elsewhere =
        operation.computer !== undefined && operation.computer.id !== thisComputer();
      // An import reads only this desktop's browsers, for its own backend (round 6f).
      if (operation.kind === "refresh" && (elsewhere || environmentId !== thisComputer())) continue;
      const into = operation.into;
      // Another desktop's own part of a sign-out, when this desktop is one of them (round 6d).
      const me = thisComputer();
      const mine = operation.others?.find(({ computer }) => computer.id === me);
      const mineUndo = operation.undone?.others?.find(({ computer }) => computer.id === me);
      const doPart = mine ? mine.outcome : operation.desktop;
      const undoPart = mineUndo ? mineUndo.outcome : operation.undone?.desktop;
      const doing: (() => Promise<ProfileStoreOutcome>) | undefined =
        doPart?.state !== "pending" || started.has(`do:${operationId}`)
          ? undefined
          : operation.kind === "sign-out" && site
            ? () =>
                (
                  bridge.signOutSiteKept?.(profileId, site, operationId, environmentId, at) ??
                  Promise.resolve(null)
                ).then((done): ProfileStoreOutcome =>
                  done
                    ? {
                        state: "done",
                        saved: done.saved,
                        notRestorable: done.notRestorable,
                        ...(done.leftBehind ? { leftBehind: done.leftBehind } : {}),
                      }
                    : { state: "failed" },
                )
            : operation.kind === "refresh"
              ? // Import or refresh from the linked browser profile: the person's own import,
                // here. A profile the import made joins this desktop's list first.
                () =>
                  (operation.madeProfile
                    ? adopt(profileId, operation.name ?? profileId)
                    : Promise.resolve()
                  ).then(() =>
                    refreshFromLink({
                      environmentId,
                      snapshot,
                      operation,
                      stillStands: () => claim(operationId, "do"),
                    }),
                  )
              : into
                ? // Copy, move, merge and fold: this desktop's partitions, as the server's did.
                  () =>
                    (
                      bridge.copyProfileSites?.(
                        profileId,
                        into,
                        operation.sites,
                        operation.kind === "move",
                        operationId,
                        environmentId,
                        at,
                      ) ?? Promise.resolve(null)
                    ).then((done): ProfileStoreOutcome =>
                      done
                        ? {
                            state: "done",
                            copied: done.copied,
                            ...(done.uncovered.length ? { uncovered: [...done.uncovered] } : {}),
                          }
                        : { state: "failed" },
                    )
                : undefined;
      if (doing) {
        started.add(`do:${operationId}`);
        // Asked first: only one desktop does it, and only while what it was decided on stands.
        void claim(operationId, "do").then((ok) =>
          ok
            ? doing()
                .catch((): ProfileStoreOutcome => ({ state: "failed" }))
                .then((outcome) => report(operationId, "do", outcome, mine && me))
            : undefined,
        );
      }
      // A refresh has no Undo: an old one still pending is never carried out (round 6n).
      if (
        operation.kind !== "refresh" &&
        undoPart?.state === "pending" &&
        !started.has(`undo:${operationId}`)
      ) {
        started.add(`undo:${operationId}`);
        void claim(operationId, "undo").then((ok) =>
          ok
            ? (
                (into
                  ? bridge.undoProfileCopy?.(profileId, into, operationId, environmentId, at)
                  : bridge.restoreSignOut?.(profileId, operationId, environmentId, at)) ??
                Promise.resolve(null)
              ).then((done) =>
                report(
                  operationId,
                  "undo",
                  done ? { state: "done", ...done } : { state: "failed" },
                  mineUndo && me,
                ),
              )
            : undefined,
        );
      }
    }
    const purged = purgedHere();
    for (const record of snapshot.profiles) {
      for (const generation of dueGenerations(record)) {
        const purge = `${environmentId}|${record.profileId}|${generation}`;
        if (purged.has(purge) || started.has(purge)) continue;
        started.add(purge);
        void bridge
          .purgeProfileData?.(record.profileId, generation, environmentId)
          // Not done: tried again with the next snapshot.
          .then((done) => (done ? markPurged(purge) : started.delete(purge)))
          .catch(() => started.delete(purge));
        // Removed, or cleared for good with no Undo: the sign-in window's remembered sign-ins go
        // too, unless signed in to there since the Clear. A Clear undone leaves them.
        const cleared = (snapshot.profileOperations ?? []).find(
          (operation) =>
            operation.kind === "clear" &&
            operation.profileId === record.profileId &&
            operation.from === generation &&
            !operation.undone,
        );
        // Once for a removed profile, once for each Clear.
        const forget = record.removed?.purgedAt
          ? `forget:${environmentId}|${record.profileId}`
          : `forget:${purge}`;
        if ((record.removed?.purgedAt || cleared) && !started.has(forget)) {
          started.add(forget);
          void (bridge.forgetChromeSignIn?.(record.profileId, cleared?.at) ?? Promise.resolve(true))
            .then((done) => done || started.delete(forget))
            .catch(() => started.delete(forget));
        }
      }
      // Purged by its computer: the profile leaves this client's list for good.
      if (record.removed?.purgedAt && !started.has(`list:${record.profileId}`)) {
        started.add(`list:${record.profileId}`);
        void persistClientSettingsUpdate((current) =>
          current.browserProfiles.some((profile) => profile.id === record.profileId)
            ? {
                ...current,
                browserProfiles: current.browserProfiles.filter(
                  (profile) => profile.id !== record.profileId,
                ),
                ...(current.browserDefaultProfileId === record.profileId
                  ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
                  : {}),
              }
            : current,
        ).catch(() => undefined);
      }
    }
  };
  return registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isSuccess(result)) follow(result.value);
    },
    { immediate: true },
  );
}
