import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  type AccountsSnapshot,
  type AccountSummary,
  type BrowserProfile,
  type BrowserImportSourceId,
  type BrowserProfileRecord,
  type DesktopAccountsBridge,
  type DesktopFillMainInput,
  type DesktopFillMainResult,
  type EnvironmentId,
  isBuiltInBrowserProfileId,
} from "@t3tools/contracts";
import { profileSignIns } from "@t3tools/shared/scientBrowserProfileChoice";
import { siteUnder, sitesNest } from "@t3tools/shared/scientSiteMatch";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { getClientSettings, persistClientSettingsUpdate } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "~/state/environments";

import { accountsState } from "./accountsState";
import { loadSourceProfiles, matchExistingProfile } from "./accountsView";
import { removeBrowserProfile } from "./removeBrowserProfile";

type FillMain = NonNullable<DesktopAccountsBridge["fillMain"]>;

const recordOf = (snapshot: Pick<AccountsSnapshot, "profiles">, profileId: string) =>
  snapshot.profiles.find((record) => record.profileId === profileId) ??
  defaultBrowserProfileRecord(profileId);

/** Only a profile with no limits gives Main its sessions; Main has none. */
const isUnrestricted = (record: BrowserProfileRecord) =>
  record.access === "allowed" &&
  record.scope.type === "all-projects" &&
  !record.allowedProjects?.length;

/** Sites the user signed out of with Accounts' Sign out on Main: an import never brings them back. */
const mainSignOuts = (snapshot: Pick<AccountsSnapshot, "profiles">) =>
  recordOf(snapshot, DEFAULT_BROWSER_PROFILE_ID).main?.signedOutSites ?? [];

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
 * Rows recording a new sign-in action in their profile (Scient signed in, a recording, Google
 * showing a new account): `signed-in` by an action, dated after the previous snapshot's. A look
 * never copies, so an imported row a Check finds signed in stays where it is.
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
    return (
      row.signIn?.state === "signed-in" &&
      row.signIn.by === "action" &&
      row.signIn.at > (before?.signIn?.at ?? "")
    );
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
        details.sites.some((mainSite) => sitesNest([mainSite], [site]))
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
    if (!landed.some((unit) => sites.every((site) => unit.sites.some((u) => siteUnder(site, u)))))
      continue;
    await accountsState.mainFilled.run(registry, {
      environmentId,
      input: { accountId: row.accountId, profileName: profileName(fromProfile) },
    });
  }
}

/**
 * Profiles that stopped being unrestricted since the last snapshot: turned Off or Ask, limited to
 * projects. On a baseline, every restricted one, so a change made while this desktop was away counts.
 */
function newlyRestricted(
  previous: Pick<AccountsSnapshot, "profiles"> | undefined,
  next: Pick<AccountsSnapshot, "profiles">,
  eligible: (profileId: string) => boolean = otherPersistentProfile,
) {
  return next.profiles
    .filter(
      ({ profileId }) =>
        eligible(profileId) &&
        !isUnrestricted(recordOf(next, profileId)) &&
        (previous === undefined || isUnrestricted(recordOf(previous, profileId))),
    )
    .map(({ profileId }) => profileId);
}

/**
 * Main's rows for the units a withdrawal removed: a copy row goes, and a saved password whose row
 * the copy marked stays, recorded signed out.
 */
export function withdrawnRows(
  accounts: ReadonlyArray<AccountSummary>,
  units: ReadonlyArray<ReadonlyArray<string>>,
) {
  const rows = accounts.filter((row) => {
    const details = website(row);
    return (
      details?.profileId === DEFAULT_BROWSER_PROFILE_ID &&
      row.signIn?.from === "copy" &&
      details.sites.every((site) => units.some((unit) => unit.some((u) => siteUnder(site, u))))
    );
  });
  return {
    remove: rows.filter((row) => Object.keys(row.secrets).length === 0).map((row) => row.accountId),
    signedOut: rows
      .filter((row) => Object.keys(row.secrets).length > 0)
      .map((row) => row.accountId),
  };
}

/** Main's fill runs with nobody watching: a failure leaves this trace, and no values. */
const warn = (what: string, cause: unknown) =>
  console.warn(`[accounts] ${what}`, cause instanceof Error ? cause.message : cause);

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
  /** Runs `run` after `ms`; the function it returns cancels that. */
  readonly later: (run: () => Promise<void>, ms: number) => () => void;
  readonly eligible?: (profileId: string) => boolean;
  /** Trigger 3, run once the environment's first snapshot arrives. */
  readonly backfill?: (snapshot: AccountsSnapshot) => Promise<void>;
  /**
   * A profile no longer unrestricted takes back from Main what its copies still hold there; true
   * once done. Until then it is tried again with every snapshot. `live` turns false once the
   * profile is unrestricted again: nothing more is taken back after that.
   */
  readonly withdraw?: (profileId: string, live: () => boolean) => Promise<boolean>;
}) {
  let previous: AccountsSnapshot | undefined;
  let backfill: Promise<void> | undefined;
  let stopped = false;
  /** Each waiting retry's cancel, with the profile it copies from. */
  const retries = new Map<() => void, string>();
  const eligible = deps.eligible ?? otherPersistentProfile;
  /** Restricted profiles whose copies Main hasn't given back yet, each with its restriction's
   * generation, and those being given back. */
  const withdrawals = new Map<string, number>();
  const withdrawing = new Set<string>();
  let generation = 0;
  /** In-flight and retrying copies, by row and revision; the oldest goes first past the limit. */
  const pending = new Map<string, number>();
  const keyOf = (row: AccountSummary) =>
    `${deps.environmentId}:${row.accountId}:${row.signIn?.at ?? row.createdAt}`;
  const copy = async (row: AccountSummary, snapshot: AccountsSnapshot): Promise<void> => {
    const key = keyOf(row);
    const profileId = website(row)!.profileId!;
    // A profile restricted since, or gone, gives Main nothing, a waiting retry included.
    if (!eligible(profileId) || !isUnrestricted(recordOf(snapshot, profileId))) {
      pending.delete(key);
      return;
    }
    const result = await deps
      .fillMain({
        environmentId: deps.environmentId,
        from: profileId,
        units: [website(row)!.sites],
        mode: "fill-or-replace",
        replaceAllowedSince: replaceAllowedSince(snapshot.accounts, row),
        skipSites: [],
      })
      .catch((cause: unknown) => {
        warn("Couldn't copy a sign-in into Main", cause);
        return null;
      });
    const outcome = result?.units[0]?.outcome;
    if (outcome === "restore-failed")
      warn(
        "A copy into Main couldn't be undone; signing out of the site in Main lets it copy again",
        {
          sites: website(row)!.sites,
        },
      );
    // A page writing the site meanwhile (`busy`) is retried like a failed copy.
    if (result && outcome !== "failed" && outcome !== "busy") {
      pending.delete(key);
      await deps
        .record(result, [row], profileId)
        .catch((cause: unknown) => warn("Couldn't record a copy into Main", cause));
      return;
    }
    const attempts = pending.get(key);
    if (stopped || attempts === undefined || attempts >= RETRIES) {
      pending.delete(key);
      return;
    }
    pending.set(key, attempts + 1);
    const cancel = deps.later(async () => {
      retries.delete(cancel);
      const now = deps.current();
      const same = now?.accounts.find((candidate) => candidate.accountId === row.accountId);
      if (now && same && keyOf(same) === key) await copy(same, now);
      else pending.delete(key);
    }, RETRY_GAP_MS);
    retries.set(cancel, profileId);
  };
  return {
    /** A reconnect makes the next snapshot a baseline again. */
    reset: () => {
      previous = undefined;
    },
    /** No retry runs after this. */
    stop: () => {
      stopped = true;
      for (const cancel of retries.keys()) cancel();
      retries.clear();
    },
    /** Resolves once this snapshot's copies are done. */
    seen: (snapshot: AccountsSnapshot) => {
      const events = previous ? signInEvents(previous, snapshot, deps.eligible) : [];
      const restricted = newlyRestricted(previous, snapshot, deps.eligible);
      for (const [cancel, from] of retries)
        if (restricted.includes(from)) {
          cancel();
          retries.delete(cancel);
        }
      previous = snapshot;
      backfill ??= deps
        .backfill?.(snapshot)
        .catch((cause: unknown) => warn("Couldn't fill Main from every profile", cause));
      const copies: Array<Promise<void>> = backfill ? [backfill] : [];
      for (const profileId of restricted) withdrawals.set(profileId, ++generation);
      for (const [profileId, current] of withdrawals) {
        // Unrestricted again: its copies may stay, and a withdrawal under way stops.
        if (isUnrestricted(recordOf(snapshot, profileId))) withdrawals.delete(profileId);
        if (!withdrawals.has(profileId) || withdrawing.has(profileId) || !deps.withdraw) continue;
        withdrawing.add(profileId);
        const live = () => withdrawals.get(profileId) === current;
        copies.push(
          deps
            .withdraw(profileId, live)
            .catch((cause: unknown) => {
              warn("Couldn't take a profile's copies back", cause);
              return false;
            })
            .then((done) => {
              withdrawing.delete(profileId);
              // A newer restriction's withdrawal is still owed.
              if (done && live()) withdrawals.delete(profileId);
            }),
        );
      }
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

/**
 * Main gives back a restricted profile's copies, durably for other computers: first the revisions
 * by which they take back theirs, for every unit Main holds from it, then Main's own, then its
 * rows. A failure before Main's own changes nothing, so the next try starts over; false until done.
 */
export async function withdrawFromMain(
  from: string,
  deps: {
    readonly native: (input: {
      readonly from: string;
      readonly heldOnly?: true;
    }) => Promise<{ readonly units: ReadonlyArray<ReadonlyArray<string>> } | null>;
    /** Records the copy-only delete other computers apply; true once persisted. */
    readonly takeBack: (sites: ReadonlyArray<string>) => Promise<boolean>;
    readonly settle: (units: ReadonlyArray<ReadonlyArray<string>>) => Promise<void>;
    /** False once the profile is unrestricted again: checked before every step that changes. */
    readonly live: () => boolean;
  },
): Promise<boolean> {
  const held = await deps.native({ from, heldOnly: true });
  if (!held || !deps.live()) return false;
  for (const sites of held.units) if (!(await deps.takeBack(sites)) || !deps.live()) return false;
  const result = await deps.native({ from });
  if (!result || !deps.live()) return false;
  if (result.units.length) await deps.settle(result.units);
  return true;
}

/** The take-back command as a withdrawal sees it: persisted only on a Success. */
export const takeBackVia =
  (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
  async (sites: ReadonlyArray<string>) =>
    (await accountsState.mainWithdrawn.run(registry, { environmentId, input: { sites } }))._tag ===
    "Success";

/** Main's row changes once its copies are withdrawn; a profile allowed again keeps the rest. */
export const settleVia =
  (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    accounts: () => ReadonlyArray<AccountSummary> | undefined,
    live: () => boolean,
  ) =>
  async (units: ReadonlyArray<ReadonlyArray<string>>) => {
    const current = accounts();
    if (!current) return;
    const { remove, signedOut } = withdrawnRows(current, units);
    for (const accountId of remove) {
      if (!live()) return;
      await accountsState.remove.run(registry, { environmentId, input: { accountId } });
    }
    for (const accountId of signedOut) {
      if (!live()) return;
      await accountsState.sessionEnded.run(registry, { environmentId, input: { accountId } });
    }
  };

/** Starts trigger 2 for the primary environment, where the desktop writes Main. */
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
    later: (run, ms) => {
      const timer = setTimeout(() => void run(), ms);
      return () => clearTimeout(timer);
    },
    backfill: async (snapshot) => {
      const profiles = resolveBrowserProfiles((await resolveBrowserDefaults()).profiles);
      // This launch's fill of each profile, so the fold reads what the back-fill just did.
      const filled = new Map<string, DesktopFillMainResult | null>();
      const fill = async (at: AccountsSnapshot, profileId: string) => {
        const result = await fillFromProfile(registry, environmentId, at, profileId);
        filled.set(profileId, result);
        return result;
      };
      await backfillMain(snapshot, {
        profiles,
        fill: async (profileId) => (await fill(snapshot, profileId)) !== null,
        done: async (profileIds) =>
          (
            await accountsState.mainBackfilled.run(registry, {
              environmentId,
              input: { profileIds: profileIds.map((id) => BrowserProfileId.make(id)) },
            })
          )._tag === "Success",
        makeMainDefault: () =>
          persistClientSettingsUpdate((current) => ({
            ...current,
            browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID,
            // Browser profiles says so once, until dismissed.
            mainDefaultNotice: true,
          })).then(() => undefined),
      });
      const after = await readSnapshot(environmentId);
      if (!after || recordOf(after, DEFAULT_BROWSER_PROFILE_ID).main?.folded) return;
      // Unreadable, the fold waits for the next launch rather than take an import for Scient's.
      const sources = await loadSourceProfiles();
      await foldIntoMain(after, {
        profiles,
        importedName: (name) => matchExistingProfile(name, sources) !== undefined,
        fill: (profileId) =>
          filled.has(profileId) ? Promise.resolve(filled.get(profileId)!) : fill(after, profileId),
        fold: async (profileId) =>
          (
            await removeBrowserProfile(registry, environmentId, profileId, {
              intoMain: true,
            }).catch((cause: unknown) => {
              warn("Couldn't merge a profile into Main", cause);
              return null;
            })
          )?._tag === "Success",
        done: async (profiles) =>
          (
            await accountsState.mainFolded.run(registry, {
              environmentId,
              input: { profiles },
            })
          )._tag === "Success",
      });
    },
    withdraw: (profileId, live) =>
      withdrawFromMain(profileId, {
        live,
        native: (input) =>
          window.desktopBridge?.accounts?.withdrawFromMain?.({ ...input, environmentId }) ??
          Promise.resolve(null),
        takeBack: takeBackVia(registry, environmentId),
        settle: settleVia(registry, environmentId, () => read()?.accounts, live),
      }),
  });
  const unsubscribe = registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isSuccess(result)) void trigger.seen(result.value);
      else if (AsyncResult.isFailure(result)) trigger.reset();
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    trigger.stop();
  };
}

const readSnapshot = async (environmentId: EnvironmentId) => {
  const read = await accountsState.readSnapshot
    .run(appAtomRegistry, { environmentId, input: {} })
    .catch((cause: unknown) => {
      warn("Couldn't read Accounts to fill Main", cause);
      return null;
    });
  return read?._tag === "Success" ? read.value : undefined;
};

/**
 * One profile's whole jar fills Main where it has nothing, except the sites the user signed out
 * of there; its multi-site sign-ins go whole. A restricted profile gives none.
 */
async function fillFromProfile(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  snapshot: AccountsSnapshot,
  profileId: string,
): Promise<DesktopFillMainResult | null> {
  const fillMain = window.desktopBridge?.accounts?.fillMain;
  const record = recordOf(snapshot, profileId);
  if (!fillMain || !otherPersistentProfile(profileId) || !isUnrestricted(record)) return null;
  // Sign-ins with evidence, and the profile's session rows (an import's): each unit copied gives
  // Main a "Copied from …" row, so a look at Main has a row to mark.
  const rows = snapshot.accounts.filter(
    (row) =>
      website(row)?.profileId === profileId &&
      (profileSignIns([row]).length > 0 ||
        (row.secrets.password === undefined && !website(row)?.institution)),
  );
  const join = rows.flatMap((row) => {
    const sites = website(row)?.sites ?? [];
    return sites.length > 1 ? [sites] : [];
  });
  const input: DesktopFillMainInput = {
    environmentId,
    from: profileId,
    ...(join.length ? { join } : {}),
    mode: "fill",
    skipSites: mainSignOuts(snapshot),
  };
  const result = await fillMain(input).catch((cause: unknown) => {
    warn("Couldn't fill Main from a profile", cause);
    return null;
  });
  if (!result) return null;
  await recordCopies(registry, environmentId, result, rows, profileId);
  return result;
}

/** An import into a profile of this desktop: its whole jar goes to other computers again. */
const resendImported = async (environmentId: EnvironmentId, profileId: string) => {
  if (environmentId !== readPrimaryEnvironmentId()) return;
  await accountsState.profileResend
    .run(appAtomRegistry, {
      environmentId,
      input: { profileId: BrowserProfileId.make(profileId), why: "import" },
    })
    .catch((cause: unknown) => warn("Couldn't mark an import to send again", cause));
};

/** Trigger 1, an import or Refresh into another profile: then its sign-ins fill Main. */
export async function fillMainFromProfile(environmentId: EnvironmentId, profileId: string) {
  const snapshot = await readSnapshot(environmentId);
  if (snapshot) await fillFromProfile(appAtomRegistry, environmentId, snapshot, profileId);
  await resendImported(environmentId, profileId);
}

/**
 * The user's Copy from a profile: one sign-in into Main through the same copy as trigger 2. It
 * never replaces what Main holds of the site, and a restricted profile gives nothing.
 */
export async function copySignInIntoMain(environmentId: EnvironmentId, row: AccountSummary) {
  const fillMain = window.desktopBridge?.accounts?.fillMain;
  const details = website(row);
  const profileId = details?.profileId;
  if (!fillMain || !details || !profileId || !otherPersistentProfile(profileId)) return undefined;
  const snapshot = await readSnapshot(environmentId);
  if (!snapshot || !isUnrestricted(recordOf(snapshot, profileId))) return undefined;
  const result = await fillMain({
    environmentId,
    from: profileId,
    units: [details.sites],
    mode: "fill",
    skipSites: [],
  }).catch((cause: unknown) => {
    warn("Couldn't copy a sign-in into Main", cause);
    return null;
  });
  if (!result) return undefined;
  await recordCopies(appAtomRegistry, environmentId, result, [row], profileId).catch(
    (cause: unknown) => warn("Couldn't record a copy into Main", cause),
  );
  return result.units[0]?.outcome;
}

/** Imported profiles first, by when they were imported, then the rest in list order. */
export function backfillOrder(
  snapshot: Pick<AccountsSnapshot, "profiles">,
  profiles: ReadonlyArray<BrowserProfile>,
) {
  const done = new Set(recordOf(snapshot, DEFAULT_BROWSER_PROFILE_ID).main?.backfilled ?? []);
  const waiting = profiles.filter(
    ({ id, kind }) =>
      kind === "persistent" &&
      id !== DEFAULT_BROWSER_PROFILE_ID &&
      !done.has(id) &&
      isUnrestricted(recordOf(snapshot, id)),
  );
  const importedAt = (id: string) => recordOf(snapshot, id).source?.importedAt;
  return [
    ...waiting
      .filter(({ id }) => importedAt(id))
      .sort((a, b) => importedAt(a.id)!.localeCompare(importedAt(b.id)!)),
    ...waiting.filter(({ id }) => !importedAt(id)),
  ].map(({ id }) => id);
}

/**
 * Trigger 3: once per environment and profile, each unrestricted profile's sessions fill Main;
 * no source profile is changed. The primary environment's first back-fill also makes Main the
 * new-tab default, once; "Use for new tabs" changes it back.
 */
export async function backfillMain(
  snapshot: AccountsSnapshot,
  deps: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly fill: (profileId: string) => Promise<boolean>;
    readonly done: (profileIds: ReadonlyArray<string>) => Promise<boolean>;
    readonly makeMainDefault?: () => Promise<void>;
  },
) {
  const first = recordOf(snapshot, DEFAULT_BROWSER_PROFILE_ID).main?.backfilled === undefined;
  let recorded = false;
  for (const profileId of backfillOrder(snapshot, deps.profiles)) {
    if (!(await deps.fill(profileId))) continue;
    recorded = (await deps.done([profileId])) || recorded;
  }
  if (first && !recorded) recorded = await deps.done([]);
  if (first && recorded) await deps.makeMainDefault?.();
}

/**
 * Profiles the one-time fold merges into Main: persistent ones made here, with no limits, whose
 * sessions the back-fill gave Main. One with a source, or named like another browser's profile
 * (an older import Accounts hasn't linked yet) unless Scient marked it its own, stays.
 */
export function foldCandidates(
  snapshot: Pick<AccountsSnapshot, "profiles">,
  profiles: ReadonlyArray<BrowserProfile>,
  importedName: (name: string) => boolean,
) {
  const backfilled = new Set(recordOf(snapshot, DEFAULT_BROWSER_PROFILE_ID).main?.backfilled);
  return profiles.filter(({ id, kind, name }) => {
    const record = recordOf(snapshot, id);
    return (
      kind === "persistent" &&
      !isBuiltInBrowserProfileId(id) &&
      !record.source &&
      !record.received &&
      isUnrestricted(record) &&
      backfilled.has(id) &&
      (record.madeInScient !== undefined || !importedName(name))
    );
  });
}

const sameUser = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether Main now holds what the profile does: each unit copied or already the same. A unit Main
 * holds differently matters where one of the profile's rows names its site, unless Main has a row
 * for the same person there; one kept out by Main's sign-out matters wherever a row names it.
 */
function foldsWhole(
  accounts: ReadonlyArray<AccountSummary>,
  profileId: string,
  result: DesktopFillMainResult,
  skipSites: ReadonlyArray<string>,
) {
  const rows = accounts.filter((row) => website(row)?.profileId === profileId);
  const named = (sites: ReadonlyArray<string>) =>
    rows.filter((row) => sitesNest(website(row)!.sites, sites));
  return result.units.every(({ sites, outcome }) => {
    switch (outcome) {
      case "copied":
      case "same":
        return true;
      case "conflict":
        return named(sites).every((row) =>
          accounts.some((main) => {
            const details = website(main);
            return (
              details?.profileId === DEFAULT_BROWSER_PROFILE_ID &&
              sitesNest(details.sites, website(row)!.sites) &&
              sameUser(details.username, website(row)!.username)
            );
          }),
        );
      // Not kept out by Main's sign-out, a blocked unit had nothing live to copy.
      case "blocked":
        return !sitesNest(sites, skipSites) || named(sites).length === 0;
      default:
        return false;
    }
  });
}

/**
 * Once per environment, after the back-fill: each profile made in Scient whose sessions Main holds
 * whole merges into Main and is removed; any other stays as it is. Recorded even when none merged;
 * an unreadable jar or a failed merge leaves it unrecorded, so the next launch tries the rest.
 */
export async function foldIntoMain(
  snapshot: AccountsSnapshot,
  deps: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly importedName: (name: string) => boolean;
    readonly fill: (profileId: string) => Promise<DesktopFillMainResult | null>;
    /** Repoints what names the profile to Main and removes it; true once done. */
    readonly fold: (profileId: string) => Promise<boolean>;
    readonly done: (names: ReadonlyArray<string>) => Promise<boolean>;
  },
) {
  if (recordOf(snapshot, DEFAULT_BROWSER_PROFILE_ID).main?.folded) return;
  const merged: string[] = [];
  let complete = true;
  for (const { id, name } of foldCandidates(snapshot, deps.profiles, deps.importedName)) {
    const result = await deps.fill(id);
    if (!result || !foldsWhole(snapshot.accounts, id, result, mainSignOuts(snapshot))) {
      // A jar that couldn't be read decided nothing about the profile.
      if (!result) complete = false;
      continue;
    }
    if (await deps.fold(id)) merged.push(name);
    else complete = false;
  }
  if (complete) await deps.done(merged);
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
  const filled = await fillMain({
    environmentId,
    from: { importSourceId, sourceProfileDirectory },
    mode: "fill",
    skipSites: mainSignOuts(snapshot),
  });
  if (filled) await resendImported(environmentId, DEFAULT_BROWSER_PROFILE_ID);
  return filled;
}
