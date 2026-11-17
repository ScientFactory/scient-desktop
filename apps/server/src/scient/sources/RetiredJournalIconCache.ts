// @effect-diagnostics nodeBuiltinImport:off -- Removes one known folder of a retired cache.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";

/** Where Scient kept website icons before journal marks were drawn in the app (2026-11). */
const RETIRED_FOLDER = ["scient", "journal-icons", "v1"] as const;

/** After activation, so the first screens load first. */
const CLEANUP_DELAY = "10 seconds";

/**
 * Deletes `<stateDir>/scient/journal-icons/v1` when it is a real folder at exactly that place: a
 * linked ancestor or a link in its place is left alone, and so is every sibling folder.
 */
export async function removeRetiredJournalIconCache(stateDir: string): Promise<boolean> {
  const folder = NodePath.join(stateDir, ...RETIRED_FOLDER);
  let resolved: string;
  try {
    resolved = await NodeFSP.realpath(folder);
  } catch {
    return false;
  }
  const expected = NodePath.join(await NodeFSP.realpath(stateDir), ...RETIRED_FOLDER);
  if (resolved !== expected || !(await NodeFSP.lstat(resolved)).isDirectory()) return false;
  await NodeFSP.rm(resolved, { recursive: true, force: true });
  return true;
}

export const retiredJournalIconCacheLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    yield* forkParked(
      Effect.sleep(CLEANUP_DELAY).pipe(
        Effect.andThen(Effect.promise(() => removeRetiredJournalIconCache(stateDir))),
        Effect.catchCause((cause) =>
          Effect.logDebug("Removing the retired journal icon cache failed.", { cause }),
        ),
      ),
    );
  }),
);
