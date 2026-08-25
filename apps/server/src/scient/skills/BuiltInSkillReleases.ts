import { loadEmbeddedSkillRelease, type SkillRelease } from "@scientfactory/scient-skills";

import { BUILT_IN_SKILL_SOURCES } from "./BuiltInSkillSources.ts";

/**
 * Reviewed Scient-owned releases embedded in the server bundle.
 *
 * Embedding keeps packaged servers independent from source-tree paths while
 * preserving the same immutable validation and digest used for imported
 * releases. Registration makes a release available; it does not activate it.
 */
export const BUILT_IN_SKILL_RELEASES: ReadonlyArray<SkillRelease> = Object.freeze(
  BUILT_IN_SKILL_SOURCES.map((source) =>
    loadEmbeddedSkillRelease(source.directoryName, source.files),
  ),
);

/** Product-owned defaults keyed by stable Scient skill ID. */
export const BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID: ReadonlyMap<string, boolean> = new Map(
  BUILT_IN_SKILL_SOURCES.map((source, index) => [
    BUILT_IN_SKILL_RELEASES[index]!.id,
    source.defaultActive,
  ]),
);
