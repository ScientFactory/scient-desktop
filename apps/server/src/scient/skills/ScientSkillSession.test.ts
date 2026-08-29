// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real skill and project boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
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
import {
  BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
  BUILT_IN_SKILL_RELEASES,
} from "./BuiltInSkillReleases.ts";
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
  options: { readonly id?: string; readonly name?: string } = {},
): Promise<string> {
  const name = options.name ?? `${activationScope}-review`;
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
      id: options.id ?? `scient.${name}`,
      version: "0.1.0",
      category: "Testing",
      categoryDescription: "Skills used by focused tests.",
      displayOrder: 100,
      supportedScopes: [activationScope],
      defaultInvocationPolicy: "automatic",
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

async function writeOwnedProjectSkill(projectRoot: string, name: string): Promise<void> {
  const root = NodePath.join(projectRoot, ".scient", "skills", name);
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: Applies this project's reviewed method.\n---\n\n# Project method\n\nFollow the project evidence.\n`,
    "utf8",
  );
}

const resolvePlan = (
  catalog: SkillCatalog,
  snapshot: ScientSkillPolicy.ScientSkillPolicySnapshot,
  input: Parameters<ScientSkillSession.ScientSkillSessionPlannerShape["resolve"]>[0],
  defaultActiveById?: ReadonlyMap<string, boolean>,
) =>
  Effect.gen(function* () {
    const planner = yield* ScientSkillSession.ScientSkillSessionPlanner;
    return yield* planner.resolve(input);
  }).pipe(
    Effect.provide(
      ScientSkillSession.layer.pipe(
        Layer.provide(
          Layer.merge(
            ScientSkillRegistry.layerFromCatalog(catalog, defaultActiveById),
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
        { userSkills: [], projectSkills: [], trustedProjects: [] },
        {
          provider: ProviderDriverKind.make("codex"),
          projectRoot,
        },
      );
      expect(untrusted.delivery).toBe("none");
      expect(untrusted.diagnostics.map((entry) => entry.code)).toContain("project-lock-untrusted");

      const trustedSnapshot: ScientSkillPolicy.ScientSkillPolicySnapshot = {
        userSkills: [],
        projectSkills: [],
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
      expect(trusted.releases).toEqual(new Map([[skillReleaseKey(release), release]]));

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
          userSkills: [
            {
              release: toSkillReleaseRef(release),
              active: true,
              invocationPolicy: "automatic",
            },
          ],
          projectSkills: [],
          trustedProjects: [],
        } satisfies ScientSkillPolicy.ScientSkillPolicySnapshot;

        const codex = yield* resolvePlan(catalog, snapshot, {
          provider: ProviderDriverKind.make("codex"),
        });
        expect(codex.delivery).toBe("mcp");
        expect(codex.projectRoot).toBeUndefined();
        expect(codex.releases).toEqual(new Map([[skillReleaseKey(release), release]]));
        expect(codex.skills).toEqual([
          expect.objectContaining({
            releaseKey: skillReleaseKey(release),
            invocationPolicy: "automatic",
          }),
        ]);

        const antigravity = yield* resolvePlan(catalog, snapshot, {
          provider: ProviderDriverKind.make("antigravity"),
        });
        expect(antigravity.delivery).toBe("unsupported");
        expect(antigravity.releases).toEqual(new Map());
        expect(antigravity.diagnostics.map((entry) => entry.code)).toContain(
          "provider-unsupported",
        );
      }),
  );

  it.effect("delivers shipping defaults unless an explicit user preference disables one", () =>
    Effect.gen(function* () {
      const catalog: SkillCatalog = { releases: BUILT_IN_SKILL_RELEASES, diagnostics: [] };
      const initial = yield* resolvePlan(
        catalog,
        { userSkills: [], projectSkills: [], trustedProjects: [] },
        { provider: ProviderDriverKind.make("codex") },
        BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
      );
      expect(initial.skills.map((skill) => [skill.name, skill.invocationPolicy])).toEqual([
        ["improve-workspace-readiness", "explicit"],
        ["scient-skill-authoring", "automatic"],
        ["workspace-readiness-review", "automatic"],
      ]);

      const review = BUILT_IN_SKILL_RELEASES.find(
        (candidate) => candidate.name === "workspace-readiness-review",
      )!;
      const disabled = yield* resolvePlan(
        catalog,
        {
          userSkills: [
            {
              release: toSkillReleaseRef(review),
              active: false,
              invocationPolicy: "automatic",
            },
          ],
          projectSkills: [],
          trustedProjects: [],
        },
        { provider: ProviderDriverKind.make("codex") },
        BUILT_IN_SKILL_DEFAULT_ACTIVE_BY_ID,
      );
      expect(disabled.skills.map((skill) => skill.name)).toEqual([
        "improve-workspace-readiness",
        "scient-skill-authoring",
      ]);
    }),
  );

  it.effect("withholds active releases whose Agent Skills names conflict", () =>
    Effect.gen(function* () {
      const firstParent = yield* Effect.promise(() => fixture("scient-skill-name-first-"));
      const secondParent = yield* Effect.promise(() => fixture("scient-skill-name-second-"));
      const firstRoot = yield* Effect.promise(() =>
        writeRelease(firstParent, "user", {
          id: "scient.shared-review-one",
          name: "shared-review",
        }),
      );
      const secondRoot = yield* Effect.promise(() =>
        writeRelease(secondParent, "user", {
          id: "scient.shared-review-two",
          name: "shared-review",
        }),
      );
      const catalog = yield* Effect.promise(() => loadSkillCatalog([firstRoot, secondRoot]));
      const snapshot = {
        userSkills: catalog.releases.map((release) => ({
          release: toSkillReleaseRef(release),
          active: true,
          invocationPolicy: "automatic" as const,
        })),
        projectSkills: [],
        trustedProjects: [],
      } satisfies ScientSkillPolicy.ScientSkillPolicySnapshot;

      const plan = yield* resolvePlan(catalog, snapshot, {
        provider: ProviderDriverKind.make("codex"),
      });
      expect(plan.delivery).toBe("none");
      expect(plan.skills).toEqual([]);
      expect(plan.releases).toEqual(new Map());
      expect(plan.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invocation-name-conflict" }),
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
        { userSkills: [], projectSkills: [], trustedProjects: [] },
        { provider: ProviderDriverKind.make("codex"), projectRoot },
      );
      expect(plan.delivery).toBe("none");
      expect(plan.releases).toEqual(new Map());
      expect(plan.diagnostics).toEqual([]);
    }),
  );

  it.effect("discovers project-owned skills as active and automatic on the next turn", () =>
    Effect.gen(function* () {
      const projectRoot = yield* Effect.promise(() => fixture("scient-owned-project-skill-"));
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
      yield* Effect.promise(() => writeOwnedProjectSkill(projectRoot, "project-method"));
      const identity = yield* Effect.promise(() => readScientProjectIdentity(projectRoot));

      const plan = yield* resolvePlan(
        { releases: [], diagnostics: [] },
        { userSkills: [], projectSkills: [], trustedProjects: [] },
        { provider: ProviderDriverKind.make("codex"), projectRoot },
      );

      expect(plan.delivery).toBe("mcp");
      expect(plan.releases.size).toBe(1);
      expect(plan.skills).toEqual([
        expect.objectContaining({
          name: "project-method",
          origin: `project:${identity.projectId}`,
          activationScope: "project",
          invocationPolicy: "automatic",
        }),
      ]);
    }),
  );

  it.effect("applies app-private project preferences by durable identity", () =>
    Effect.gen(function* () {
      const projectRoot = yield* Effect.promise(() => fixture("scient-project-preference-"));
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
      yield* Effect.promise(() => writeOwnedProjectSkill(projectRoot, "project-method"));
      const identity = yield* Effect.promise(() => readScientProjectIdentity(projectRoot));
      const baseSnapshot = {
        userSkills: [],
        trustedProjects: [],
        projectSkills: [
          {
            projectId: identity.projectId,
            name: "project-method",
            active: true,
            invocationPolicy: "explicit" as const,
          },
        ],
      } satisfies ScientSkillPolicy.ScientSkillPolicySnapshot;

      const explicit = yield* resolvePlan({ releases: [], diagnostics: [] }, baseSnapshot, {
        provider: ProviderDriverKind.make("codex"),
        projectRoot,
      });
      expect(explicit.skills).toEqual([
        expect.objectContaining({ name: "project-method", invocationPolicy: "explicit" }),
      ]);

      const disabled = yield* resolvePlan(
        { releases: [], diagnostics: [] },
        {
          ...baseSnapshot,
          projectSkills: [{ ...baseSnapshot.projectSkills[0]!, active: false }],
        },
        { provider: ProviderDriverKind.make("codex"), projectRoot },
      );
      expect(disabled.delivery).toBe("none");
      expect(disabled.skills).toEqual([]);

      const worktreeRoot = yield* Effect.promise(() => fixture("scient-project-worktree-"));
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(worktreeRoot, ".scient"), { recursive: true });
        await NodeFSP.copyFile(
          NodePath.join(projectRoot, ".scient", "project.json"),
          NodePath.join(worktreeRoot, ".scient", "project.json"),
        );
        await writeOwnedProjectSkill(worktreeRoot, "project-method");
      });
      const disabledWorktree = yield* resolvePlan(
        { releases: [], diagnostics: [] },
        {
          ...baseSnapshot,
          projectSkills: [{ ...baseSnapshot.projectSkills[0]!, active: false }],
        },
        { provider: ProviderDriverKind.make("codex"), projectRoot: worktreeRoot },
      );
      expect(disabledWorktree.delivery).toBe("none");
    }),
  );

  it.effect("withholds a project skill that shadows any Scient-managed name", () =>
    Effect.gen(function* () {
      const projectRoot = yield* Effect.promise(() => fixture("scient-project-collision-"));
      yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));
      yield* Effect.promise(() =>
        writeOwnedProjectSkill(projectRoot, "workspace-readiness-review"),
      );

      const plan = yield* resolvePlan(
        { releases: BUILT_IN_SKILL_RELEASES, diagnostics: [] },
        { userSkills: [], projectSkills: [], trustedProjects: [] },
        { provider: ProviderDriverKind.make("codex"), projectRoot },
        new Map(BUILT_IN_SKILL_RELEASES.map((release) => [release.id, false])),
      );

      expect(plan.delivery).toBe("none");
      expect(plan.diagnostics).toEqual([
        expect.objectContaining({ code: "project-skill-collision" }),
      ]);
    }),
  );
});
