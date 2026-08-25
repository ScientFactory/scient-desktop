import {
  catalogByReleaseKey,
  createSkillCatalog,
  type SkillCatalog,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
  BUILT_IN_SKILL_RELEASES,
} from "./BuiltInSkillReleases.ts";

const EMPTY_CATALOG: SkillCatalog = Object.freeze({
  releases: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

export interface ScientSkillRegistryShape {
  readonly catalog: SkillCatalog;
  readonly resolveReleaseKey: (releaseKey: string) => SkillRelease | undefined;
  readonly defaultActive: (release: SkillRelease) => boolean;
}

const fromCatalog = (
  catalog: SkillCatalog,
  defaultActiveById: ReadonlyMap<string, boolean> = new Map(),
): ScientSkillRegistryShape => {
  const byReleaseKey = catalogByReleaseKey(catalog);
  return {
    catalog,
    resolveReleaseKey: (releaseKey) => byReleaseKey.get(releaseKey),
    defaultActive: (release) =>
      release.origin === "scient" ? (defaultActiveById.get(release.id) ?? false) : false,
  };
};

/** Empty by default so the generic server remains dormant without Scient releases. */
export class ScientSkillRegistry extends Context.Reference<ScientSkillRegistryShape>(
  "t3/scient/skills/ScientSkillRegistry",
  { defaultValue: () => fromCatalog(EMPTY_CATALOG) },
) {}

export const layerFromCatalog = (
  catalog: SkillCatalog,
  defaultActiveById?: ReadonlyMap<string, boolean>,
) => Layer.succeed(ScientSkillRegistry, fromCatalog(catalog, defaultActiveById));

export const layer = Layer.effect(
  ScientSkillRegistry,
  Effect.sync(() =>
    createSkillCatalog(
      BUILT_IN_SKILL_RELEASES.map((release) => ({
        source: `built-in:${release.id}@${release.version}`,
        release,
      })),
    ),
  ).pipe(
    Effect.tap((catalog) =>
      Effect.forEach(
        catalog.diagnostics,
        (diagnostic) => Effect.logWarning("Scient skill release was quarantined", { diagnostic }),
        { discard: true },
      ),
    ),
    Effect.map((catalog) => fromCatalog(catalog, BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID)),
  ),
);
