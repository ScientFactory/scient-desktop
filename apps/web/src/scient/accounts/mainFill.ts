import {
  DEFAULT_BROWSER_PROFILE_ID,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  type AccountsSnapshot,
  type AccountSummary,
  type BrowserImportSourceId,
  type BrowserProfileRecord,
  type DesktopAccountsBridge,
  type DesktopFillMainInput,
  type DesktopFillMainResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { profileSignIns } from "@t3tools/shared/scientBrowserProfileChoice";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { accountsState } from "./accountsState";

type FillMain = NonNullable<DesktopAccountsBridge["fillMain"]>;

const recordOf = (snapshot: Pick<AccountsSnapshot, "profiles">, profileId: string) =>
  snapshot.profiles.find((record) => record.profileId === profileId) ??
  defaultBrowserProfileRecord(profileId);

/** Only a profile with no limits gives Main its sessions; Main has none. */
const isUnrestricted = (record: BrowserProfileRecord) =>
  record.access === "allowed" &&
  record.scope.type === "all-projects" &&
  !record.allowedProjects?.length;

const sourceControls = (record: BrowserProfileRecord) => ({
  access: record.access,
  scope: record.scope,
  ...(record.allowedProjects ? { allowedProjects: record.allowedProjects } : {}),
});

/** Sites the user signed out of with Accounts' Sign out on Main: an import never brings them back. */
const mainSignOuts = (snapshot: Pick<AccountsSnapshot, "profiles">) =>
  recordOf(snapshot, DEFAULT_BROWSER_PROFILE_ID).signedOutSites ?? [];

const hostOf = (site: string) => (site.startsWith("https://") ? new URL(site).hostname : site);
const under = (site: string, unitSite: string) => {
  const host = hostOf(site);
  return host === unitSite || host.endsWith(`.${unitSite}`);
};
const website = (row: AccountSummary) => (row.details.kind === "website" ? row.details : undefined);

/** Persistent Scient profiles other than Main, which can give Main their sessions. */
const otherPersistentProfile = (profileId: string) =>
  profileId !== DEFAULT_BROWSER_PROFILE_ID &&
  resolveBrowserProfiles(getClientSettings().browserProfiles).some(
    (profile) => profile.id === profileId && profile.kind === "persistent",
  );

const profileName = (profileId: string) =>
  resolveBrowserProfiles(getClientSettings().browserProfiles).find(
    (profile) => profile.id === profileId,
  )?.name ?? "another profile";

/**
 * Rows that newly say their profile is signed in: one that appears with evidence (a recording,
 * Google's list), or one whose sign-in turns `signed-in` (Scient signed in, or a look saw it).
 */
function signInEvents(
  previous: Pick<AccountsSnapshot, "accounts" | "profiles">,
  next: Pick<AccountsSnapshot, "accounts" | "profiles">,
  eligible: (profileId: string) => boolean = otherPersistentProfile,
): ReadonlyArray<AccountSummary> {
  return next.accounts.filter((row) => {
    const profileId = website(row)?.profileId;
    if (!profileId || !eligible(profileId) || !isUnrestricted(recordOf(next, profileId)))
      return false;
    const before = previous.accounts.find((old) => old.accountId === row.accountId);
    return before
      ? before.signIn?.state !== "signed-in" && row.signIn?.state === "signed-in"
      : profileSignIns([row]).length > 0;
  });
}

/** For each of the row's sites whose Main row was last seen signed out: when that was seen. */
export function replaceAllowedSince(accounts: ReadonlyArray<AccountSummary>, row: AccountSummary) {
  const since: Record<string, string> = {};
  for (const site of website(row)?.sites ?? [])
    for (const main of accounts) {
      const details = website(main);
      if (
        details?.profileId === DEFAULT_BROWSER_PROFILE_ID &&
        main.signIn?.state === "signed-out" &&
        details.sites.some(
          (mainSite) => under(mainSite, hostOf(site)) || under(site, hostOf(mainSite)),
        )
      )
        since[site] = main.signIn.at;
    }
  return since;
}

/** After a copy, each unit copied or already the same gets Main's row for the sign-in. */
async function recordCopies(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  result: DesktopFillMainResult,
  rows: ReadonlyArray<AccountSummary>,
  fromProfile: string,
) {
  const landed = result.units.filter(({ outcome }) => outcome === "copied" || outcome === "same");
  for (const row of rows) {
    const sites = website(row)?.sites ?? [];
    if (
      !landed.some((unit) =>
        sites.every((site) => unit.sites.some((u) => site === u || under(site, u))),
      )
    )
      continue;
    await accountsState.mainFilled.run(registry, {
      environmentId,
      input: { accountId: row.accountId, profileName: profileName(fromProfile) },
    });
  }
}

const RETRIES = 2;
const RETRY_GAP_MS = 10 * 60 * 1000;
const IN_FLIGHT_LIMIT = 200;

/**
 * Trigger 2: a sign-in seen in another profile is copied into Main as it happens. The first
 * snapshot after a start or a reconnect is only a baseline; nothing is copied in the background.
 */
export function mainFillTrigger(deps: {
  readonly environmentId: EnvironmentId;
  readonly fillMain: FillMain;
  readonly current: () => AccountsSnapshot | undefined;
  readonly record: (
    result: DesktopFillMainResult,
    rows: ReadonlyArray<AccountSummary>,
    from: string,
  ) => Promise<void>;
  readonly later: (run: () => Promise<void>, ms: number) => void;
  readonly eligible?: (profileId: string) => boolean;
}) {
  let previous: AccountsSnapshot | undefined;
  /** In-flight and retrying copies, by row and revision; the oldest goes first past the limit. */
  const pending = new Map<string, number>();
  const keyOf = (row: AccountSummary) =>
    `${deps.environmentId}:${row.accountId}:${row.signIn?.at ?? row.createdAt}`;
  const copy = async (row: AccountSummary, snapshot: AccountsSnapshot): Promise<void> => {
    const key = keyOf(row);
    const profileId = website(row)!.profileId!;
    const result = await deps
      .fillMain({
        environmentId: deps.environmentId,
        from: profileId,
        sourceControls: sourceControls(recordOf(snapshot, profileId)),
        units: [website(row)!.sites],
        mode: "fill-or-replace",
        replaceAllowedSince: replaceAllowedSince(snapshot.accounts, row),
        skipSites: [],
      })
      .catch(() => null);
    const outcome = result?.units[0]?.outcome;
    if (result && outcome !== "failed") {
      pending.delete(key);
      await deps.record(result, [row], profileId).catch(() => undefined);
      return;
    }
    const attempts = pending.get(key);
    if (attempts === undefined || attempts >= RETRIES) {
      pending.delete(key);
      return;
    }
    pending.set(key, attempts + 1);
    deps.later(async () => {
      const now = deps.current();
      const same = now?.accounts.find((candidate) => candidate.accountId === row.accountId);
      if (now && same && keyOf(same) === key) await copy(same, now);
      else pending.delete(key);
    }, RETRY_GAP_MS);
  };
  return {
    /** A reconnect makes the next snapshot a baseline again. */
    reset: () => {
      previous = undefined;
    },
    /** Resolves once this snapshot's copies are done. */
    seen: (snapshot: AccountsSnapshot) => {
      const events = previous ? signInEvents(previous, snapshot, deps.eligible) : [];
      previous = snapshot;
      const copies: Array<Promise<void>> = [];
      for (const row of events) {
        const key = keyOf(row);
        if (pending.has(key)) continue;
        pending.set(key, 0);
        if (pending.size > IN_FLIGHT_LIMIT) pending.delete(pending.keys().next().value!);
        copies.push(copy(row, snapshot));
      }
      return Promise.all(copies).then(() => undefined);
    },
  };
}

/** Starts trigger 2 for an environment, where the desktop can write Main. */
export function watchMainFill(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const fillMain = window.desktopBridge?.accounts?.fillMain;
  if (!fillMain) return () => undefined;
  const atom = accountsState.snapshot({ environmentId, input: {} });
  const read = () => {
    const result = registry.get(atom);
    return AsyncResult.isSuccess(result) ? result.value : undefined;
  };
  const trigger = mainFillTrigger({
    environmentId,
    fillMain,
    current: read,
    record: (result, rows, from) => recordCopies(registry, environmentId, result, rows, from),
    later: (run, ms) => void setTimeout(() => void run(), ms),
  });
  return registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isSuccess(result)) void trigger.seen(result.value);
      else if (AsyncResult.isFailure(result)) trigger.reset();
    },
    { immediate: true },
  );
}

const readSnapshot = async (environmentId: EnvironmentId) => {
  const read = await accountsState.readSnapshot
    .run(appAtomRegistry, { environmentId, input: {} })
    .catch(() => null);
  return read?._tag === "Success" ? read.value : undefined;
};

/**
 * Trigger 1, an import or Refresh into another profile: then the same sign-ins fill Main where
 * it has none, except the sites the user signed out of there. A restricted profile gives none.
 */
export async function fillMainFromProfile(environmentId: EnvironmentId, profileId: string) {
  const fillMain = window.desktopBridge?.accounts?.fillMain;
  const snapshot = await readSnapshot(environmentId);
  if (!fillMain || !snapshot || !otherPersistentProfile(profileId)) return;
  const record = recordOf(snapshot, profileId);
  if (!isUnrestricted(record)) return;
  const rows = snapshot.accounts.filter(
    (row) => website(row)?.profileId === profileId && profileSignIns([row]).length > 0,
  );
  const join = rows.flatMap((row) => {
    const sites = website(row)?.sites ?? [];
    return sites.length > 1 ? [sites] : [];
  });
  const input: DesktopFillMainInput = {
    environmentId,
    from: profileId,
    sourceControls: sourceControls(record),
    ...(join.length ? { join } : {}),
    mode: "fill",
    skipSites: mainSignOuts(snapshot),
  };
  const result = await fillMain(input).catch(() => null);
  if (result) await recordCopies(appAtomRegistry, environmentId, result, rows, profileId);
}

/** Trigger 1, an import whose target is Main: through the coordinator, never the upstream writer. */
export async function importIntoMain(
  environmentId: EnvironmentId,
  importSourceId: BrowserImportSourceId,
  sourceProfileDirectory: string,
) {
  const fillMain = window.desktopBridge?.accounts?.fillMain;
  // Without Main's sign-out record, an import could bring back a site the user left.
  const snapshot = await readSnapshot(environmentId);
  if (!fillMain || !snapshot) return null;
  return fillMain({
    environmentId,
    from: { importSourceId, sourceProfileDirectory },
    mode: "fill",
    skipSites: mainSignOuts(snapshot),
  });
}
