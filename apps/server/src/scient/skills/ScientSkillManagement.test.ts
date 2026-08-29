// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the app-private policy boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
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
  it.effect("applies shipping defaults and persists an explicit disabled preference", () =>
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
        const initial = yield* management.list();
        expect(initial.skills.map((skill) => skill.name)).toEqual([
          "workspace-readiness-review",
          "improve-workspace-readiness",
          "scient-skill-authoring",
        ]);
        expect(initial.skills.map((skill) => skill.category)).toEqual([
          "Workspace readiness",
          "Workspace readiness",
          "Skill creation",
        ]);
        expect(new Set(initial.skills.map((skill) => skill.categoryDescription))).toEqual(
          new Set([
            "Review and improve a workspace so people and agents can understand it and work safely.",
            "Create and improve reusable guidance for Scient agents.",
          ]),
        );
        expect(initial.skills.every((skill) => skill.scope === "user")).toBe(true);
        expect(initial.skills.every((skill) => skill.defaultActive)).toBe(true);
        expect(initial.skills.every((skill) => skill.active)).toBe(true);
        expect(initial.supportedProviders).not.toContain("antigravity");
        expect(initial.supportedProviders).not.toContain("cursor");

        const selected = initial.skills.find((skill) => skill.name === "scient-skill-authoring")!;
        const updated = yield* management.setUserActivation({
          releaseKey: selected.releaseKey,
          active: false,
          invocationPolicy: "explicit",
        });
        expect(
          updated.skills.find((skill) => skill.releaseKey === selected.releaseKey),
        ).toMatchObject({ defaultActive: true, active: false, invocationPolicy: "explicit" });
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

  it.effect("lists and controls project-owned skills without importing them", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-skills-state-"));
        fixtures.push(root);
        return root;
      });
      const projectRoot = yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "scient-skills-project-"),
        );
        fixtures.push(root);
        await initializeScientProject({ root });
        const skillRoot = NodePath.join(root, ".scient", "skills", "project-method");
        await NodeFSP.mkdir(skillRoot, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(skillRoot, "SKILL.md"),
          "---\nname: project-method\ndescription: Applies the project method.\n---\n\nFollow project evidence.\n",
          "utf8",
        );
        return root;
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const managementLayer = ScientSkillManagement.layer.pipe(
        Layer.provide(
          Layer.merge(
            ScientSkillRegistry.layer,
            ScientSkillPolicy.layer.pipe(Layer.provide(configLayer)),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const initial = yield* management.list(projectRoot);
        expect(initial.skills.find((skill) => skill.name === "project-method")).toMatchObject({
          scope: "project",
          path: ".scient/skills/project-method",
          active: true,
          invocationPolicy: "automatic",
        });

        const updated = yield* management.setProjectPreference({
          projectRoot,
          name: "project-method",
          active: false,
          invocationPolicy: "explicit",
        });
        expect(updated.skills.find((skill) => skill.name === "project-method")).toMatchObject({
          active: false,
          invocationPolicy: "explicit",
        });
        expect(updated.skills.filter((skill) => skill.scope === "user")).toHaveLength(3);
      }).pipe(Effect.provide(managementLayer));
    }),
  );
});
