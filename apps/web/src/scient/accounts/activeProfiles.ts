import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
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

/** A profile merged into Main opens as Main. */
export const activeProfileId = (profileId: string) =>
  appAtomRegistry.get(retiredAtom).has(profileId) ? DEFAULT_BROWSER_PROFILE_ID : profileId;
