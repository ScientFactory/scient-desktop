// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real skill and project boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject } from "@scientfactory/project-init";
import {
  loadSkillCatalog,
  skillReleaseKey,
  toSkillReleaseRef,
  writeProjectSkillLock,
  type SkillActivationScope,
  type SkillCatalog,
} from "@scientfactory/scient-skills";
import { ProviderDriverKind } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";
import * as ScientSkillSession from "./ScientSkillSession.ts";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";

const fixtures: string[] = [];

async function fixture(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

async function writeRelease(
  parent: string,
  activationScope: SkillActivationScope,
): Promise<string> {
  const name = `${activationScope}-review`;
  const root = NodePath.join(parent, name);
  await NodeFSP.mkdir(NodePath.join(root, "references"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: Reviews bounded evidence for this test.\n---\n\n# Review\n\nRead the rubric only when needed.\n`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "scient.skill.json"),
    `${JSON.stringify({
      apiVersion: "scient.skills/v1alpha1",
      id: `scient.${name}`,
      version: "0.1.0",
      activationScope,
      origin: { kind: "scient" },
    })}\n`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "references", "rubric.md"),
    "Report uncertainty.\n",
    "utf8",
  );
  return root;
}

const resolvePlan = (
  catalog: SkillCatalog,
  snapshot: ScientSkillPolicy.ScientSkillPolicySnapshot,
  input: Parameters<ScientSkillSession.ScientSkillSessionPlannerShape["resolve"]>[0],
) =>
  Effect.gen(function* () {
    const planner = yield* ScientSkillSession.ScientSkillSessionPlanner;
    return yield* planner.resolve(input);
  }).pipe(
    Effect.provide(
      ScientSkillSession.layer.pipe(
        Layer.provide(
          Layer.merge(
            ScientSkillRegistry.layerFromCatalog(catalog),
            ScientSkillPolicy.layerFromSnapshot(snapshot),
          ),
        ),
      ),
    ),
  );

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Scient skill session planning", () => {
  it("requires an explicit delivery decision for every built-in provider", () => {
    expect(Object.keys(ScientSkillSession.SCIENT_SKILL_DELIVERY).toSorted()).toEqual(
      BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).toSorted(),
    );
    expect(
      ScientSkillSession.scientSkillDeliveryForProvider(ProviderDriverKind.make("future-provider")),
    ).toBe("unsupported");
  });

  it.effect("withholds project skills until the exact current lock is trusted", () =>
    Effect.gen(function* () {
      const releaseParent = yield* Effect.promise(() => fixture("scient-skill-session-release-"));
      const projectRoot = yield* Effect.promise(() => fixture("scient-skill-session-project-"));
      const releaseRoot = yield* Effect.promise(() => writeRelease(releaseParent, "project"));
      const catalog = yield* Effect.promise(() => loadSkillCatalog([releaseRoot]));
      const release = catalog.releases[0]!;
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
      const lock = yield* Effect.promise(() =>
        writeProjectSkillLock(projectRoot, [toSkillReleaseRef(release)]),
      );

      const untrusted = yield* resolvePlan(
        catalog,
        { userSkills: [], trustedProjects: [] },
        {
          provider: ProviderDriverKind.make("codex"),
          projectRoot,
        },
      );
      expect(untrusted.delivery).toBe("none");
      expect(untrusted.diagnostics.map((entry) => entry.code)).toContain("project-lock-untrusted");

      const trustedSnapshot: ScientSkillPolicy.ScientSkillPolicySnapshot = {
        userSkills: [],
        trustedProjects: [
          {
            projectId: lock.projectId,
            rootPath: lock.rootPath,
            lockDigest: lock.lockDigest,
          },
        ],
      };
      const trusted = yield* resolvePlan(catalog, trustedSnapshot, {
        provider: ProviderDriverKind.make("codex"),
        projectRoot,
      });
      expect(trusted.delivery).toBe("mcp");
      expect(trusted.releaseKeys).toEqual(new Set([skillReleaseKey(release)]));

      yield* Effect.promise(() => writeProjectSkillLock(projectRoot, []));
      const changed = yield* resolvePlan(catalog, trustedSnapshot, {
        provider: ProviderDriverKind.make("codex"),
        projectRoot,
      });
      expect(changed.delivery).toBe("none");
      expect(changed.diagnostics.map((entry) => entry.code)).toContain("project-lock-untrusted");
    }),
  );

  it.effect(
    "delivers exact user activations without a project and is truthful for Antigravity",
    () =>
      Effect.gen(function* () {
        const parent = yield* Effect.promise(() => fixture("scient-user-skill-session-"));
        const root = yield* Effect.promise(() => writeRelease(parent, "user"));
        const catalog = yield* Effect.promise(() => loadSkillCatalog([root]));
        const release = catalog.releases[0]!;
        const snapshot = {
          userSkills: [toSkillReleaseRef(release)],
          trustedProjects: [],
        } satisfies ScientSkillPolicy.ScientSkillPolicySnapshot;

        const codex = yield* resolvePlan(catalog, snapshot, {
          provider: ProviderDriverKind.make("codex"),
        });
        expect(codex.delivery).toBe("mcp");
        expect(codex.projectRoot).toBeUndefined();
        expect(codex.releaseKeys).toEqual(new Set([skillReleaseKey(release)]));

        const antigravity = yield* resolvePlan(catalog, snapshot, {
          provider: ProviderDriverKind.make("antigravity"),
        });
        expect(antigravity.delivery).toBe("unsupported");
        expect(antigravity.releaseKeys).toEqual(new Set());
        expect(antigravity.diagnostics.map((entry) => entry.code)).toContain(
          "provider-unsupported",
        );
      }),
  );

  it.effect("does not scan provider-native .agents skills", () =>
    Effect.gen(function* () {
      const projectRoot = yield* Effect.promise(() => fixture("scient-native-skill-project-"));
      const nativeSkill = NodePath.join(projectRoot, ".agents", "skills", "native-only");
      yield* Effect.promise(() => NodeFSP.mkdir(nativeSkill, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(nativeSkill, "SKILL.md"),
          "---\nname: native-only\ndescription: Provider-owned.\n---\nInstructions\n",
          "utf8",
        ),
      );

      const plan = yield* resolvePlan(
        { releases: [], diagnostics: [] },
        { userSkills: [], trustedProjects: [] },
        { provider: ProviderDriverKind.make("codex"), projectRoot },
      );
      expect(plan.delivery).toBe("none");
      expect(plan.releaseKeys).toEqual(new Set());
    }),
  );
});
