// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the app-private policy boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ScientSkillManagement from "./ScientSkillManagement.ts";
import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient skill management", () => {
  it.effect("lists inactive built-ins and persists one exact personal activation", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-skills-manage-"));
        fixtures.push(root);
        return root;
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const policyLayer = ScientSkillPolicy.layer.pipe(Layer.provide(configLayer));
      const managementLayer = ScientSkillManagement.layer.pipe(
        Layer.provide(Layer.merge(ScientSkillRegistry.layer, policyLayer)),
      );

      yield* Effect.gen(function* () {
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const initial = yield* management.list;
        expect(initial.skills.map((skill) => skill.name)).toEqual([
          "improve-workspace-readiness",
          "workspace-readiness-review",
        ]);
        expect(initial.skills.every((skill) => !skill.active)).toBe(true);
        expect(initial.supportedProviders).not.toContain("antigravity");
        expect(initial.supportedProviders).not.toContain("cursor");

        const selected = initial.skills.find(
          (skill) => skill.name === "workspace-readiness-review",
        )!;
        const updated = yield* management.setUserActivation({
          releaseKey: selected.releaseKey,
          active: true,
          invocationPolicy: "automatic",
        });
        expect(
          updated.skills.find((skill) => skill.releaseKey === selected.releaseKey),
        ).toMatchObject({ active: true, invocationPolicy: "automatic" });
      }).pipe(Effect.provide(managementLayer));
    }),
  );

  it.effect("rejects a release that is not part of this build", () =>
    Effect.gen(function* () {
      const management = yield* ScientSkillManagement.ScientSkillManagement;
      const error = yield* Effect.flip(
        management.setUserActivation({
          releaseKey: "scient.missing@0.1.0#sha256:missing",
          active: true,
          invocationPolicy: "explicit",
        }),
      );
      expect(error.message).toContain("not available");
    }).pipe(Effect.provide(ScientSkillManagement.layer)),
  );
});
