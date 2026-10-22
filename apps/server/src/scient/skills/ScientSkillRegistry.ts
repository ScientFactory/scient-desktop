import {
  catalogByReleaseKey,
  createSkillCatalog,
  skillOriginKey,
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

/** One consistent catalog for a single management or turn-planning operation. */
export interface ScientSkillCatalogView {
  readonly catalog: SkillCatalog;
  readonly resolveReleaseKey: (releaseKey: string) => SkillRelease | undefined;
  readonly defaultActive: (release: SkillRelease) => boolean;
}

/** Immutable releases contributed by one enabled add-on (a Scient plugin bundle). */
export interface AddonSkillContribution {
  readonly addonId: string;
  readonly addonVersion: string;
  readonly releases: ReadonlyArray<SkillRelease>;
}

export interface AddonSkillRejection {
  readonly addonId: string;
  readonly skillId: string;
  readonly message: string;
}

export interface ScientSkillRegistryShape {
  /** The current reviewed catalog. Add-on releases may change between reads. */
  readonly current: Effect.Effect<ScientSkillCatalogView>;
  /**
   * Replace every add-on release. A release must carry its add-on's exact
   * origin and cannot reuse a skill id or name already registered by Scient or
   * by another add-on; such releases are withheld and reported.
   */
  readonly replaceAddonReleases: (
    contributions: ReadonlyArray<AddonSkillContribution>,
  ) => Effect.Effect<ReadonlyArray<AddonSkillRejection>>;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const makeView = (
  catalog: SkillCatalog,
  defaultActiveById: ReadonlyMap<string, boolean>,
): ScientSkillCatalogView => {
  const byReleaseKey = catalogByReleaseKey(catalog);
  return {
    catalog,
    resolveReleaseKey: (releaseKey) => byReleaseKey.get(releaseKey),
    // Shipping defaults are Scient-owned; an add-on can never be active by default.
    defaultActive: (release) =>
      release.origin === "scient" ? (defaultActiveById.get(release.id) ?? false) : false,
  };
};

const makeRegistry = (
  base: SkillCatalog,
  defaultActiveById: ReadonlyMap<string, boolean> = new Map(),
): ScientSkillRegistryShape => {
  let view = makeView(base, defaultActiveById);

  const replaceAddonReleases: ScientSkillRegistryShape["replaceAddonReleases"] = (contributions) =>
    Effect.sync(() => {
      const rejections: AddonSkillRejection[] = [];
      const takenIds = new Set(base.releases.map((release) => release.id));
      const takenNames = new Set(base.releases.map((release) => release.name.toLowerCase()));
      const accepted: Array<{ readonly source: string; readonly release: SkillRelease }> = [];
      for (const contribution of [...contributions].sort((left, right) =>
        compareStrings(left.addonId, right.addonId),
      )) {
        const origin = skillOriginKey({
          kind: "addon",
          addonId: contribution.addonId,
          addonVersion: contribution.addonVersion,
        });
        for (const release of contribution.releases) {
          const reject = (message: string) =>
            rejections.push({ addonId: contribution.addonId, skillId: release.id, message });
          if (release.origin !== origin) {
            reject(`Skill '${release.id}' does not carry origin '${origin}'.`);
            continue;
          }
          if (takenIds.has(release.id)) {
            reject(`Skill id '${release.id}' is already registered.`);
            continue;
          }
          if (takenNames.has(release.name.toLowerCase())) {
            reject(`Skill name '${release.name}' is already registered.`);
            continue;
          }
          takenIds.add(release.id);
          takenNames.add(release.name.toLowerCase());
          accepted.push({ source: `${origin}/${release.id}`, release });
        }
      }
      const addonCatalog = createSkillCatalog(accepted);
      const releases = [...base.releases, ...addonCatalog.releases].sort(
        (left, right) =>
          compareStrings(left.id, right.id) ||
          compareStrings(right.version, left.version) ||
          compareStrings(left.digest, right.digest),
      );
      view = makeView(
        Object.freeze({ releases: Object.freeze(releases), diagnostics: base.diagnostics }),
        defaultActiveById,
      );
      return rejections;
    });

  return {
    current: Effect.sync(() => view),
    replaceAddonReleases,
  };
};

/** Empty by default so the generic server remains dormant without Scient releases. */
export class ScientSkillRegistry extends Context.Reference<ScientSkillRegistryShape>(
  "t3/scient/skills/ScientSkillRegistry",
  { defaultValue: () => makeRegistry(EMPTY_CATALOG) },
) {}

export const layerFromCatalog = (
  catalog: SkillCatalog,
  defaultActiveById?: ReadonlyMap<string, boolean>,
) => Layer.sync(ScientSkillRegistry, () => makeRegistry(catalog, defaultActiveById));

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
    Effect.map((catalog) => makeRegistry(catalog, BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID)),
  ),
);
