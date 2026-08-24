import {
  catalogByReleaseKey,
  loadSkillCatalog,
  type SkillCatalog,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BUILT_IN_SKILL_RELEASE_ROOTS } from "./BuiltInSkillReleases.ts";

const EMPTY_CATALOG: SkillCatalog = Object.freeze({
  releases: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

export interface ScientSkillRegistryShape {
  readonly catalog: SkillCatalog;
  readonly resolveReleaseKey: (releaseKey: string) => SkillRelease | undefined;
}

const fromCatalog = (catalog: SkillCatalog): ScientSkillRegistryShape => {
  const byReleaseKey = catalogByReleaseKey(catalog);
  return {
    catalog,
    resolveReleaseKey: (releaseKey) => byReleaseKey.get(releaseKey),
  };
};

/** Empty by default so the generic server remains dormant without Scient releases. */
export class ScientSkillRegistry extends Context.Reference<ScientSkillRegistryShape>(
  "t3/scient/skills/ScientSkillRegistry",
  { defaultValue: () => fromCatalog(EMPTY_CATALOG) },
) {}

export const layerFromCatalog = (catalog: SkillCatalog) =>
  Layer.succeed(ScientSkillRegistry, fromCatalog(catalog));

export const layer = Layer.effect(
  ScientSkillRegistry,
  Effect.tryPromise(() => loadSkillCatalog(BUILT_IN_SKILL_RELEASE_ROOTS)).pipe(
    Effect.tap((catalog) =>
      Effect.forEach(
        catalog.diagnostics,
        (diagnostic) => Effect.logWarning("Scient skill release was quarantined", { diagnostic }),
        { discard: true },
      ),
    ),
    Effect.map(fromCatalog),
    Effect.orDie,
  ),
);
