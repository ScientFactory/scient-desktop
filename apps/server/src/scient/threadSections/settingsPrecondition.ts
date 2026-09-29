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
 * the settings write lock, so the check and the write are atomic. Every
 * applied catalog keeps the stored `createdInProjects` (see below).
 */
export function applyThreadSectionsPrecondition(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const { threadSectionsExpected: expected, ...rest } = patch;
  const unchanged =
    expected === undefined ||
    (current.threadSectionsGeneralIndex === expected.threadSectionsGeneralIndex &&
      threadSectionCatalogsEqual(current.threadSections, expected.threadSections));
  if (unchanged) {
    return rest.threadSections === undefined
      ? rest
      : {
          ...rest,
          threadSections: keepCreatedInProjects(current.threadSections, rest.threadSections),
        };
  }
  const { threadSections: _sections, threadSectionsGeneralIndex: _generalIndex, ...others } = rest;
  return others;
}

/**
 * Keeps every project a stored section was created for. The precondition
 * ignores `createdInProjects` so clients that predate it can still write, which
 * means a write can be based on a copy missing newer refs (or, from such a
 * client, missing the field entirely). Refs are only ever added, so the stored
 * ones are merged back into the written entry with the same id.
 */
function keepCreatedInProjects(
  stored: ServerSettings["threadSections"],
  written: NonNullable<ServerSettingsPatch["threadSections"]>,
): NonNullable<ServerSettingsPatch["threadSections"]> {
  const storedById = new Map(stored.map((section) => [section.id as string, section]));
  return written.map((section) => {
    const kept = storedById.get(section.id)?.createdInProjects ?? [];
    if (kept.length === 0) return section;
    const refs = [...kept];
    const keys = new Set(refs.map((ref) => `${ref.environmentId}:${ref.projectId}`));
    for (const ref of section.createdInProjects ?? []) {
      if (!keys.has(`${ref.environmentId}:${ref.projectId}`)) refs.push(ref);
    }
    return { ...section, createdInProjects: refs };
  });
}
