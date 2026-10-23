import {
  loadEmbeddedSkillRelease,
  type SkillCatalog,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BUILT_IN_SKILL_RELEASES } from "./BuiltInSkillReleases.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";

const builtIn = BUILT_IN_SKILL_RELEASES[0]!;

const readDefault = (release: SkillRelease, configuredDefault: boolean) =>
  Effect.gen(function* () {
    const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
    return (yield* registry.current).defaultActive(release);
  }).pipe(
    Effect.provide(
      ScientSkillRegistry.layerFromCatalog(
        { releases: [release], diagnostics: [] } satisfies SkillCatalog,
        new Map([[release.id, configuredDefault]]),
      ),
    ),
  );

const addonSkill = (input: {
  readonly name: string;
  readonly id: string;
  readonly addonId: string;
  readonly addonVersion: string;
}) =>
  loadEmbeddedSkillRelease(input.name, {
    "SKILL.md": `---\nname: ${input.name}\ndescription: Add-on guidance for ${input.name}.\n---\n\nFollow the add-on steps.\n`,
    "scient.skill.json": JSON.stringify({
      apiVersion: "scient.skills/v1alpha1",
      id: input.id,
      version: "1.0.0",
      category: "Add-on skills",
      categoryDescription: "Skills from an installed plugin.",
      displayOrder: 10,
      supportedScopes: ["user"],
      defaultInvocationPolicy: "automatic",
      origin: { kind: "addon", addonId: input.addonId, addonVersion: input.addonVersion },
    }),
  });

describe("Scient skill registry shipping defaults", () => {
  it.effect("accepts defaults only for Scient-owned releases", () =>
    Effect.gen(function* () {
      expect(yield* readDefault(builtIn, true)).toBe(true);
      expect(yield* readDefault(builtIn, false)).toBe(false);

      const addonRelease: SkillRelease = {
        ...builtIn,
        origin: "addon:example@1.0.0",
      };
      expect(yield* readDefault(addonRelease, true)).toBe(false);
    }),
  );
});

describe("Scient skill registry add-on releases", () => {
  it.effect("adds, replaces and withdraws add-on releases without touching built-ins", () =>
    Effect.gen(function* () {
      const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
      const release = addonSkill({
        name: "lab-notes",
        id: "acme.lab-notes",
        addonId: "acme.lab",
        addonVersion: "1.2.0",
      });
      expect(
        yield* registry.replaceAddonReleases([
          { addonId: "acme.lab", addonVersion: "1.2.0", releases: [release] },
        ]),
      ).toEqual([]);
      const withAddon = yield* registry.current;
      expect(withAddon.catalog.releases.map((entry) => entry.origin).toSorted()).toEqual([
        "addon:acme.lab@1.2.0",
        "scient",
      ]);
      expect(withAddon.resolveReleaseKey(`acme.lab-notes@1.0.0#${release.digest}`)).toBe(release);
      expect(withAddon.defaultActive(release)).toBe(false);

      yield* registry.replaceAddonReleases([]);
      const withdrawn = yield* registry.current;
      expect(withdrawn.catalog.releases).toEqual([builtIn]);
      expect(withdrawn.resolveReleaseKey(`acme.lab-notes@1.0.0#${release.digest}`)).toBe(undefined);
    }).pipe(
      Effect.provide(
        ScientSkillRegistry.layerFromCatalog(
          { releases: [builtIn], diagnostics: [] },
          new Map([[builtIn.id, true]]),
        ),
      ),
    ),
  );

  it.effect("withholds releases with a foreign origin or a taken id or name", () =>
    Effect.gen(function* () {
      const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
      const foreignOrigin = addonSkill({
        name: "foreign",
        id: "acme.foreign",
        addonId: "other.addon",
        addonVersion: "1.0.0",
      });
      const shadowsBuiltIn = addonSkill({
        name: builtIn.name,
        id: "acme.shadow",
        addonId: "acme.lab",
        addonVersion: "1.0.0",
      });
      const first = addonSkill({
        name: "shared",
        id: "acme.shared",
        addonId: "acme.lab",
        addonVersion: "1.0.0",
      });
      const second = addonSkill({
        name: "shared",
        id: "zeta.shared",
        addonId: "zeta.lab",
        addonVersion: "1.0.0",
      });
      const rejections = yield* registry.replaceAddonReleases([
        { addonId: "zeta.lab", addonVersion: "1.0.0", releases: [second] },
        {
          addonId: "acme.lab",
          addonVersion: "1.0.0",
          releases: [foreignOrigin, shadowsBuiltIn, first],
        },
      ]);
      expect(rejections.map((rejection) => rejection.skillId)).toEqual([
        "acme.foreign",
        "acme.shadow",
        "zeta.shared",
      ]);
      const view = yield* registry.current;
      expect(view.catalog.releases.map((entry) => entry.id).toSorted()).toEqual([
        "acme.shared",
        builtIn.id,
      ]);
      expect(view.catalog.diagnostics).toEqual([]);
    }).pipe(
      Effect.provide(
        ScientSkillRegistry.layerFromCatalog({ releases: [builtIn], diagnostics: [] }),
      ),
    ),
  );
});
