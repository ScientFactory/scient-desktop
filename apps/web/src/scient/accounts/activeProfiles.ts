import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type EnvironmentId,
  type BrowserProfile,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { accountsState } from "./accountsState";

type Records = ReadonlyArray<Pick<BrowserProfileRecord, "profileId" | "retired">>;

const NONE: ReadonlySet<string> = new Set();

const retiredIn = (records: Records): ReadonlySet<string> =>
  new Set(records.flatMap((record) => (record.retired ? [record.profileId] : [])));

/** Profiles this desktop's server says the fold merged into Main; none until it answers. */
const retiredAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  if (primary === null) return NONE;
  const snapshot = AsyncResult.getOrElse(
    get(accountsState.snapshot({ environmentId: primary, input: {} })),
    () => null,
  );
  return snapshot ? retiredIn(snapshot.profiles) : NONE;
}).pipe(Atom.keepAlive, Atom.withLabel("accounts:retired-profiles"));

export const useRetiredProfiles = () => useAtomValue(retiredAtom);

/** The profiles in use: the client's list without those merged into Main. */
export function activeProfiles(
  list: ReadonlyArray<BrowserProfile>,
  retired: ReadonlySet<string> | Records = appAtomRegistry.get(retiredAtom),
) {
  const merged = "has" in retired ? retired : retiredIn(retired);
  return resolveBrowserProfiles(list).filter((profile) => !merged.has(profile.id));
}

const ANSWER_WAIT_MS = 3_000;
const answered = (primary: EnvironmentId) =>
  AsyncResult.getOrElse(
    appAtomRegistry.get(accountsState.snapshot({ environmentId: primary, input: {} })),
    () => null,
  ) !== null;

/**
 * A profile merged into Main opens as Main. An open made before Accounts answers waits for it, up
 * to 3 s, then goes ahead. Every open passes here, so the desktop's partition lookup needn't check.
 */
export async function activeProfileId(profileId: string) {
  const primary = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (primary !== null && !isBuiltInBrowserProfileId(profileId) && !answered(primary))
    await new Promise<void>((resolve) => {
      const stops: Array<() => void> = [];
      const done = () => {
        for (const stop of stops) stop();
        resolve();
      };
      const timer = setTimeout(done, ANSWER_WAIT_MS);
      stops.push(
        () => clearTimeout(timer),
        appAtomRegistry.subscribe(
          accountsState.snapshot({ environmentId: primary, input: {} }),
          () => answered(primary) && done(),
        ),
      );
    });
  return appAtomRegistry.get(retiredAtom).has(profileId) ? DEFAULT_BROWSER_PROFILE_ID : profileId;
}
