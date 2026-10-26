import {
  type ServerSettings,
  type ServerSettingsPatch,
  threadSectionCatalogsEqual,
} from "@t3tools/contracts";

/**
 * Check section preconditions inside the settings write lock to avoid lost concurrent catalog
 * edits. Drop only stale section keys so clients can reapply against returned state; retain other
 * settings and stored createdInProjects.
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
 * createdInProjects is add-only and excluded from preconditions for old-client compatibility. Merge
 * stored refs back by section ID so stale or field-unaware clients cannot erase them.
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
