// @effect-diagnostics globalDate:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off -- Cookie transactions run as plain async Electron work.
import {
  AccountAccess,
  BrowserImportSourceId,
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  GrantScope,
  INCOGNITO_BROWSER_PROFILE_ID,
  IsoDateTime,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ProjectId,
  type DesktopFillMainResult,
} from "@t3tools/contracts";
import {
  applyUnit,
  isLive,
  deleteCookies,
  jarUnits,
  mergeUnits,
  readJar,
  setCookies,
  shareable,
  unitCookies,
  unitSites,
  unitFingerprint,
  withdrawCopies,
  type CdpSend,
  type CookieStore,
  type MainCopy,
  type UnitOutcome,
} from "@t3tools/shared/scientSessionCookies";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { resolvePartitionScope } from "../../ipc/methods/preview.ts";
import { BrowserImport } from "../../preview/BrowserImport/BrowserImport.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { mainCopyRecords } from "./mainCopies.ts";
import { mainInsertTracker, markOwnWrites, watchForeignInserts } from "./mainInserts.ts";
import { withCookieDebugger } from "./sessionCookies.ts";
import { siteCookieRemovals } from "./signedInSites.ts";

const Site = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253));
const Units = Schema.Array(Schema.Array(Site).check(Schema.isMaxLength(50))).check(
  Schema.isMaxLength(1000),
);
export const FillMainInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  from: Schema.Union([
    BrowserProfileId,
    Schema.Struct({
      importSourceId: BrowserImportSourceId,
      sourceProfileDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    }),
  ]),
  sourceControls: Schema.optional(
    Schema.Struct({
      access: AccountAccess,
      scope: GrantScope,
      allowedProjects: Schema.optional(Schema.Array(ProjectId)),
    }),
  ),
  units: Schema.optional(Units),
  join: Schema.optional(Units),
  mode: Schema.Literals(["fill", "fill-or-replace"]),
  replaceAllowedSince: Schema.optional(Schema.Record(Site, IsoDateTime)),
  skipSites: Schema.Array(Site).check(Schema.isMaxLength(20_000)),
});
export type FillMainInput = typeof FillMainInput.Type;

/** One lock per environment: Scient's copies into its Main never interleave. */
const locks = new Map<string, Promise<unknown>>();
function underMainLock<A>(environmentId: string, run: () => Promise<A>): Promise<A> {
  const next = (locks.get(environmentId) ?? Promise.resolve()).then(run, run);
  locks.set(
    environmentId,
    next.catch(() => undefined),
  );
  return next;
}

/** Units whose restore failed stay refused until the app restarts; one Main per environment. */
const refused = new WeakMap<object, Set<string>>();
const refusedIn = (main: Electron.Session) => {
  let sites = refused.get(main);
  if (!sites) refused.set(main, (sites = new Set()));
  return sites;
};

/** A session's jar through CDP; its own writes are marked so they never count as foreign. */
export function jarStore(session: Electron.Session, send: CdpSend): CookieStore {
  return {
    readUnit: async (unit) => unitCookies(unit, (await readJar(send)).cookies),
    set: async (cookies) => {
      markOwnWrites(session, cookies);
      await setCookies(send, cookies);
    },
    remove: (cookies) => deleteCookies(send, cookies),
  };
}

/**
 * Copies the source session's units into Main, one transaction each; the source is only read.
 * `record` keeps what each unit it wrote holds, while the Main lock is still held.
 */
export async function copyIntoMain(
  source: Electron.Session,
  main: Electron.Session,
  input: FillMainInput,
  record?: (copies: ReadonlyArray<Omit<MainCopy, "from">>) => Promise<void>,
): Promise<DesktopFillMainResult> {
  const tracker = mainInsertTracker(main);
  const failed = refusedIn(main);
  const skipped = unitSites(input.skipSites);
  return withCookieDebugger(source, (readSource) =>
    withCookieDebugger(main, async (sendMain) => {
      const { cookies: jar, unsupported } = await readJar(readSource);
      const store = jarStore(main, sendMain);
      const units: Array<{ sites: string[]; outcome: UnitOutcome }> = [];
      // Units sharing a site are one component, decided once, before anything is written.
      const planned = input.units ? mergeUnits(input.units) : jarUnits(jar, input.join);
      for (const unit of planned) {
        const sites = [...unitSites(unit)];
        const since = unit.flatMap((entry) => {
          const at = input.replaceAllowedSince?.[entry];
          return at === undefined ? [] : [Date.parse(at)];
        });
        let outcome: UnitOutcome;
        if (sites.some((entry) => failed.has(entry))) outcome = "restore-failed";
        else if (sites.some((entry) => skipped.has(entry))) outcome = "blocked";
        else {
          const foreign = watchForeignInserts(main);
          try {
            outcome = await applyUnit(store, {
              unit,
              source: jar,
              mode: input.mode,
              // The tracker can't vouch for a time before it started; then replace is refused.
              replaceAllowed:
                since.length > 0 &&
                tracker !== undefined &&
                !tracker.touchedSince(sites, Math.min(...since)),
              nowSeconds: Date.now() / 1000,
              foreign: () => foreign.cookies,
            });
          } finally {
            foreign.stop();
          }
          if (outcome === "restore-failed") for (const entry of sites) failed.add(entry);
        }
        units.push({ sites: [...unit], outcome });
      }
      const nowSeconds = Date.now() / 1000;
      await record?.(
        planned.flatMap((unit, index) => {
          // Only a write makes the copy Main's source; `same` keeps whoever wrote it first.
          if (units[index]?.outcome !== "copied") return [];
          const written = unitCookies(unit, jar).filter((cookie) => isLive(cookie, nowSeconds));
          return [{ sites: [...unit], fingerprint: unitFingerprint(written, nowSeconds) }];
        }),
      );
      if (units.some(({ outcome }) => outcome === "copied" || outcome.endsWith("failed")))
        await main.cookies.flushStore().catch(() => undefined);
      return { units, unsupported };
    }),
  );
}

const unrestricted = (controls: FillMainInput["sourceControls"]) =>
  controls?.access === "allowed" &&
  controls.scope.type === "all-projects" &&
  !controls.allowedProjects?.length;

/**
 * The one writer of Scient's copies into an environment's Main. A profile source must be
 * unrestricted; an import goes through a throwaway in-memory partition, so the upstream importer
 * never writes Main. Null when refused or when a jar can't be opened.
 */
export const fillMain = Effect.fn("DesktopAccounts.fillMain")(function* (input: FillMainInput) {
  const environmentId = input.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
  const from = input.from;
  if (
    typeof from === "string" &&
    (from === DEFAULT_BROWSER_PROFILE_ID ||
      from === INCOGNITO_BROWSER_PROFILE_ID ||
      !unrestricted(input.sourceControls))
  )
    return null;
  const manager = yield* PreviewManager;
  const profileSession = (profileId: string) => {
    const scope = resolvePartitionScope(environmentId, profileId);
    return manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace);
  };
  const main = yield* profileSession(DEFAULT_BROWSER_PROFILE_ID).pipe(Effect.option);
  if (main._tag === "None") return null;
  if (typeof from === "string") {
    const source = yield* profileSession(from).pipe(Effect.option);
    if (source._tag === "None") return null;
    const records = yield* copyRecords;
    return yield* Effect.promise(() =>
      underMainLock(environmentId, () =>
        copyIntoMain(source.value, main.value, input, (copies) =>
          records.record(
            environmentId,
            copies.map((copy) => ({ ...copy, from })),
          ),
        ),
      ).catch(() => null),
    );
  }
  const scope = `scient-import-staging:${crypto.randomUUID()}`;
  const browserImport = yield* BrowserImport;
  yield* browserImport.importCookies({
    input: {
      sourceId: from.importSourceId,
      sourceProfileDirectory: from.sourceProfileDirectory,
      targetProfileId: BrowserProfileId.make("scient-import-staging"),
    },
    scope,
    persistent: false,
  });
  const staging = yield* manager.getBrowserSession(scope, false).pipe(Effect.option);
  if (staging._tag === "None") return null;
  return yield* Effect.promise(() =>
    underMainLock(environmentId, () => copyIntoMain(staging.value, main.value, input))
      .catch(() => null)
      .finally(() => staging.value.clearStorageData().catch(() => undefined)),
  );
});

const copyRecords = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return mainCopyRecords(environment.path.join(environment.stateDir, "scient", "main-copies.json"));
});

export const WithdrawMainInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  from: BrowserProfileId,
});

/**
 * A profile turned Off, restricted or limited to projects takes back what it gave Main: each unit
 * still holding exactly what its copy wrote is removed, under the Main lock. Later sign-ins in Main
 * stay. The units removed, or null when Main can't be opened.
 */
export const withdrawFromMain = Effect.fn("DesktopAccounts.withdrawFromMain")(function* (
  input: typeof WithdrawMainInput.Type,
) {
  const environmentId = input.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
  const records = yield* copyRecords;
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(environmentId, DEFAULT_BROWSER_PROFILE_ID);
  const main = yield* manager
    .getBrowserSession(scope.scope, scope.persistent, scope.namespace)
    .pipe(Effect.option);
  if (main._tag === "None") return null;
  return yield* Effect.promise(() =>
    underMainLock(environmentId, async () => {
      const copies = await records.from(environmentId, input.from);
      if (copies.length === 0) return { units: [] };
      const units = await withCookieDebugger(main.value, (send) =>
        withdrawCopies(jarStore(main.value, send), copies, () => Date.now() / 1000),
      );
      await records.forget(environmentId, input.from);
      if (units.length) await main.value.cookies.flushStore().catch(() => undefined);
      return { units: units.map((unit) => [...unit]) };
    }).catch(() => null),
  );
});

/** Removes a site's cookies from a session's jar, the way Accounts' Sign out does. */
export async function removeSiteCookies(session: Electron.Session, site: string) {
  const removals = siteCookieRemovals(await session.cookies.get({}), site);
  await Promise.all(removals.map(({ url, name }) => session.cookies.remove(url, name)));
  await session.cookies.flushStore();
}

/** Accounts' Sign out on Main, under the same lock as every copy into it. */
export const signOutMainSite = Effect.fn("DesktopAccounts.signOutMainSite")(function* (
  site: string,
  environmentId: string,
) {
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(environmentId, DEFAULT_BROWSER_PROFILE_ID);
  const main = yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace);
  return yield* Effect.promise(() =>
    underMainLock(environmentId, () => removeSiteCookies(main, site)).then(
      () => true,
      () => false,
    ),
  );
});

export const ReadSessionsInput = Schema.Struct({
  profileId: BrowserProfileId,
  controls: Schema.Struct({
    access: AccountAccess,
    scope: GrantScope,
    allowedProjects: Schema.optional(Schema.Array(ProjectId)),
    scriptSignIn: Schema.Boolean,
  }),
  units: Schema.optional(Units),
  join: Schema.optional(Units),
});

/**
 * A shareable profile's live sign-ins in the primary environment's jar, each unit whole, for other
 * computers. It takes the Main lock, so it never reads a unit a copy into Main is half-way through.
 */
export const readSessions = Effect.fn("DesktopAccounts.readSessions")(function* (
  input: typeof ReadSessionsInput.Type,
) {
  if (!shareable(input.profileId, input.controls)) return null;
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(PRIMARY_LOCAL_ENVIRONMENT_ID, input.profileId);
  const session = yield* manager
    .getBrowserSession(scope.scope, scope.persistent, scope.namespace)
    .pipe(Effect.option);
  if (session._tag === "None" || !scope.persistent) return null;
  return yield* Effect.promise(() =>
    underMainLock(PRIMARY_LOCAL_ENVIRONMENT_ID, () =>
      withCookieDebugger(session.value, async (send) => {
        const nowSeconds = Date.now() / 1000;
        const live = (await readJar(send)).cookies.filter((cookie) => isLive(cookie, nowSeconds));
        const planned = input.units ? mergeUnits(input.units) : jarUnits(live, input.join);
        return {
          units: planned.flatMap((unit) => {
            const cookies = unitCookies(unit, live);
            return cookies.length ? [{ sites: [...unit], cookies }] : [];
          }),
        };
      }),
    ).catch(() => null),
  );
});
