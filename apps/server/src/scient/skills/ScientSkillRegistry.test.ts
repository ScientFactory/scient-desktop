import type { SkillCatalog, SkillRelease } from "@scientfactory/scient-skills";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BUILT_IN_SKILL_RELEASES } from "./BuiltInSkillReleases.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";

const builtIn = BUILT_IN_SKILL_RELEASES[0]!;

const readDefault = (release: SkillRelease, configuredDefault: boolean) =>
  Effect.gen(function* () {
    const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
    return registry.defaultActive(release);
  }).pipe(
    Effect.provide(
      ScientSkillRegistry.layerFromCatalog(
        { releases: [release], diagnostics: [] } satisfies SkillCatalog,
        new Map([[release.id, configuredDefault]]),
      ),
    ),
  );

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
