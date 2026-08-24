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
