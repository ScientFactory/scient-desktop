// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the app-private policy filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import { writeProjectSkillLock, type SkillReleaseRef } from "@scientfactory/scient-skills";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";

const fixtures: string[] = [];
const release: SkillReleaseRef = {
  id: "scient.user-review",
  version: "0.1.0",
  digest: `sha256:${"a".repeat(64)}`,
  origin: "scient",
};

async function fixture(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-skill-policy-"));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient skill policy", () => {
  it.effect("loads without writing and persists only explicit user activation", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(fixture);
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const policyLayer = ScientSkillPolicy.layer.pipe(Layer.provide(configLayer));

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        expect(yield* policy.snapshot).toEqual({ userSkills: [], trustedProjects: [] });
        const policyFileExists = yield* Effect.promise(async () => {
          try {
            await NodeFSP.stat(NodePath.join(config.stateDir, "scient-skills.json"));
            return true;
          } catch {
            return false;
          }
        });
        expect(policyFileExists).toBe(false);

        yield* policy.setUserSkillActive(release, true);
        expect((yield* policy.snapshot).userSkills).toEqual([release]);
        const persistedContents = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(config.stateDir, "scient-skills.json"), "utf8"),
        );
        const persisted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          persistedContents,
        );
        expect(persisted).toMatchObject({ formatVersion: 1, userSkills: [release] });

        yield* policy.setUserSkillActive(release, false);
        expect((yield* policy.snapshot).userSkills).toEqual([]);
      }).pipe(Effect.provide(Layer.merge(configLayer, policyLayer)));
    }),
  );

  it.effect("records and revokes app-owned trust for one exact project lock", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(fixture);
      const projectRoot = yield* Effect.promise(fixture);
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
      const lock = yield* Effect.promise(() => writeProjectSkillLock(projectRoot, [release]));
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const policyLayer = ScientSkillPolicy.layer.pipe(Layer.provide(configLayer));

      yield* Effect.gen(function* () {
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        const receipt = yield* policy.trustProjectLock(projectRoot);
        expect(receipt).toEqual({
          projectId: lock.projectId,
          rootPath: lock.rootPath,
          lockDigest: lock.lockDigest,
        });
        expect((yield* policy.snapshot).trustedProjects).toEqual([receipt]);

        yield* policy.revokeProjectTrust(projectRoot);
        expect((yield* policy.snapshot).trustedProjects).toEqual([]);
      }).pipe(Effect.provide(policyLayer));
    }),
  );
});
