import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { accountsState } from "./accountsState";

/**
 * The generation a profile's data is in on a computer (round 6b): Clear moves it to a new one.
 * A tab's partition follows it, so an open tab reloads into the cleared data.
 */
export const profileGenerationAtom = Atom.family((key: string) => {
  const [environmentId, profileId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    const snapshot = AsyncResult.getOrElse(
      get(accountsState.snapshot({ environmentId, input: {} })),
      () => null,
    );
    return (
      snapshot?.profiles.find((record) => record.profileId === (profileId || "default"))
        ?.generation ?? 0
    );
  });
});

/** Tells this desktop the generations before a tab asks for its partition. */
export async function syncProfileGenerations(environmentId: EnvironmentId) {
  const snapshot = AsyncResult.getOrElse(
    appAtomRegistry.get(accountsState.snapshot({ environmentId, input: {} })),
    () => null,
  );
  if (!snapshot) return;
  await window.desktopBridge?.accounts
    ?.setProfileGenerations?.(
      Object.fromEntries(
        snapshot.profiles.flatMap((record) =>
          record.generation ? [[record.profileId, record.generation] as const] : [],
        ),
      ),
      environmentId,
    )
    .catch(() => undefined);
}
