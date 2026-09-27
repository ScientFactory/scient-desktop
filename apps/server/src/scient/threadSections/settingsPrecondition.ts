import {
  type ServerSettings,
  type ServerSettingsPatch,
  threadSectionCatalogsEqual,
} from "@t3tools/contracts";

/**
 * Applies a thread-section edit's precondition. Clients replace the whole
 * section catalog, so two clients editing at once would otherwise lose one
 * edit. A patch whose `threadSectionsExpected` no longer matches the stored
 * catalog keeps its other keys but drops the section keys; the client sees
 * its edit missing from the returned settings and reapplies it. Runs inside
 * the settings write lock, so the check and the write are atomic.
 */
export function applyThreadSectionsPrecondition(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const { threadSectionsExpected: expected, ...rest } = patch;
  if (expected === undefined) return rest;
  const unchanged =
    current.threadSectionsGeneralIndex === expected.threadSectionsGeneralIndex &&
    threadSectionCatalogsEqual(current.threadSections, expected.threadSections);
  if (unchanged) return rest;
  const { threadSections: _sections, threadSectionsGeneralIndex: _generalIndex, ...others } = rest;
  return others;
}
