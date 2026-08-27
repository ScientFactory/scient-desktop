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
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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
        expect(yield* policy.snapshot).toEqual({
          userSkills: [],
          projectSkills: [],
          trustedProjects: [],
        });
        const policyFileExists = yield* Effect.promise(async () => {
          try {
            await NodeFSP.stat(NodePath.join(config.stateDir, "scient-skills.json"));
            return true;
          } catch {
            return false;
          }
        });
        expect(policyFileExists).toBe(false);

        yield* policy.setUserSkillActivation(release, true, "automatic");
        expect((yield* policy.snapshot).userSkills).toEqual([
          { release, active: true, invocationPolicy: "automatic" },
        ]);
        const persistedContents = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(config.stateDir, "scient-skills.json"), "utf8"),
        );
        const persisted = yield* decodeUnknownJson(persistedContents);
        expect(persisted).toMatchObject({
          formatVersion: 4,
          userSkills: [{ release, active: true, invocationPolicy: "automatic" }],
        });

        yield* policy.setUserSkillActivation(release, false, "explicit");
        expect((yield* policy.snapshot).userSkills).toEqual([
          { release, active: false, invocationPolicy: "explicit" },
        ]);
        const disabledContents = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(config.stateDir, "scient-skills.json"), "utf8"),
        );
        expect(yield* decodeUnknownJson(disabledContents)).toMatchObject({
          formatVersion: 4,
          userSkills: [{ release, active: false, invocationPolicy: "explicit" }],
        });
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

  it.effect("migrates the dormant v1 activation format to explicit invocation", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(fixture);
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
      const encodedV1 = yield* encodeUnknownJson({
        formatVersion: 1,
        userSkills: [release],
        trustedProjects: [],
      });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(config.stateDir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(config.stateDir, "scient-skills.json"),
          encodedV1,
          "utf8",
        );
      });

      const snapshot = yield* Effect.gen(function* () {
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        return yield* policy.snapshot;
      }).pipe(Effect.provide(ScientSkillPolicy.layer.pipe(Layer.provide(configLayer))));

      expect(snapshot.userSkills).toEqual([
        { release, active: true, invocationPolicy: "explicit" },
      ]);
      expect(snapshot.projectSkills).toEqual([]);
    }),
  );

  it.effect("migrates v2 activations to explicit active preferences", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(fixture);
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
      const encodedV2 = yield* encodeUnknownJson({
        formatVersion: 2,
        userSkills: [{ release, invocationPolicy: "automatic" }],
        trustedProjects: [],
      });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(config.stateDir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(config.stateDir, "scient-skills.json"),
          encodedV2,
          "utf8",
        );
      });

      const snapshot = yield* Effect.gen(function* () {
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        return yield* policy.snapshot;
      }).pipe(Effect.provide(ScientSkillPolicy.layer.pipe(Layer.provide(configLayer))));

      expect(snapshot.userSkills).toEqual([
        { release, active: true, invocationPolicy: "automatic" },
      ]);
      expect(snapshot.projectSkills).toEqual([]);
    }),
  );

  it.effect("migrates the shipped v3 policy without changing explicit choices", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(fixture);
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
      const encodedV3 = yield* encodeUnknownJson({
        formatVersion: 3,
        userSkills: [{ release, active: false, invocationPolicy: "explicit" }],
        trustedProjects: [],
      });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(config.stateDir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(config.stateDir, "scient-skills.json"),
          encodedV3,
          "utf8",
        );
      });

      const snapshot = yield* Effect.gen(function* () {
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        return yield* policy.snapshot;
      }).pipe(Effect.provide(ScientSkillPolicy.layer.pipe(Layer.provide(configLayer))));

      expect(snapshot).toEqual({
        userSkills: [{ release, active: false, invocationPolicy: "explicit" }],
        projectSkills: [],
        trustedProjects: [],
      });
    }),
  );

  it.effect("persists an explicit project preference including a return to automatic", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(fixture);
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const policyLayer = ScientSkillPolicy.layer.pipe(Layer.provide(configLayer));

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        yield* policy.setProjectSkillPreference(
          "project-identity",
          "evidence-review",
          false,
          "explicit",
        );
        yield* policy.setProjectSkillPreference(
          "project-identity",
          "evidence-review",
          true,
          "automatic",
        );

        expect((yield* policy.snapshot).projectSkills).toEqual([
          {
            projectId: "project-identity",
            name: "evidence-review",
            active: true,
            invocationPolicy: "automatic",
          },
        ]);
        const contents = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(config.stateDir, "scient-skills.json"), "utf8"),
        );
        expect(yield* decodeUnknownJson(contents)).toMatchObject({
          formatVersion: 4,
          projectSkills: [
            {
              projectId: "project-identity",
              name: "evidence-review",
              active: true,
              invocationPolicy: "automatic",
            },
          ],
        });
      }).pipe(Effect.provide(Layer.merge(configLayer, policyLayer)));
    }),
  );
});
