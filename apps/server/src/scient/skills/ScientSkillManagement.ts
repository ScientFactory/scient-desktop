import {
  loadProjectSkillCatalog,
  skillReleaseKey,
  toSkillReleaseRef,
  type SkillInvocationPolicy,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import {
  ProviderDriverKind,
  ScientSkillManagementError,
  type ScientSkillInventory,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";
import { resolveEffectiveUserSkillPolicies } from "./ScientSkillEffectivePolicy.ts";
import { SCIENT_SKILL_DELIVERY } from "./ScientSkillSession.ts";

export interface ScientSkillManagementShape {
  readonly list: (
    projectRoot?: string,
  ) => Effect.Effect<ScientSkillInventory, ScientSkillManagementError>;
  readonly setUserActivation: (input: {
    readonly releaseKey: string;
    readonly active: boolean;
    readonly invocationPolicy: SkillInvocationPolicy;
  }) => Effect.Effect<ScientSkillInventory, ScientSkillManagementError>;
  readonly setProjectPreference: (input: {
    readonly projectRoot: string;
    readonly name: string;
    readonly active: boolean;
    readonly invocationPolicy: SkillInvocationPolicy;
  }) => Effect.Effect<ScientSkillInventory, ScientSkillManagementError>;
}

const emptyManagement: ScientSkillManagementShape = {
  list: () => Effect.succeed({ skills: [], diagnostics: [], supportedProviders: [] }),
  setUserActivation: () =>
    Effect.fail(
      new ScientSkillManagementError({
        operation: "setUserActivation",
        message: "Scient skill management is unavailable in this server composition.",
      }),
    ),
  setProjectPreference: () =>
    Effect.fail(
      new ScientSkillManagementError({
        operation: "setProjectPreference",
        message: "Scient skill management is unavailable in this server composition.",
      }),
    ),
};

/** Inert by default so generic server/test compositions do not acquire product state. */
export class ScientSkillManagement extends Context.Reference<ScientSkillManagementShape>(
  "t3/scient/skills/ScientSkillManagement",
  { defaultValue: () => emptyManagement },
) {}

const supportedProviders = Object.entries(SCIENT_SKILL_DELIVERY)
  .filter(([, delivery]) => delivery === "mcp")
  .map(([provider]) => ProviderDriverKind.make(provider));

const compareReleasesForPresentation = (left: SkillRelease, right: SkillRelease): number =>
  left.displayOrder - right.displayOrder || left.id.localeCompare(right.id);

const make = Effect.fn("ScientSkillManagement.make")(function* () {
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const policy = yield* ScientSkillPolicy.ScientSkillPolicy;

  const listUserSkills = Effect.gen(function* () {
    const snapshot = yield* policy.snapshot;
    const effectiveByReleaseKey = new Map(
      resolveEffectiveUserSkillPolicies(registry, snapshot).map(
        (effective) => [skillReleaseKey(effective.release), effective] as const,
      ),
    );
    return {
      skills: [...registry.catalog.releases].sort(compareReleasesForPresentation).map((release) => {
        const effective = effectiveByReleaseKey.get(skillReleaseKey(release));
        return {
          releaseKey: skillReleaseKey(release),
          id: release.id,
          version: release.version,
          name: release.name,
          description: release.description,
          category: release.category,
          categoryDescription: release.categoryDescription,
          origin: release.origin,
          scope: "user" as const,
          supportedScopes: [...release.supportedScopes],
          defaultInvocationPolicy: release.defaultInvocationPolicy,
          defaultActive: effective?.defaultActive ?? false,
          active: effective?.active ?? false,
          invocationPolicy: effective?.invocationPolicy ?? release.defaultInvocationPolicy,
        };
      }),
      diagnostics: [],
      supportedProviders,
    } satisfies ScientSkillInventory;
  });

  const inspectProject = Effect.fn("ScientSkillManagement.inspectProject")(function* (
    projectRoot: string,
  ) {
    const catalog = yield* Effect.tryPromise(() => loadProjectSkillCatalog(projectRoot)).pipe(
      Effect.mapError(
        () =>
          new ScientSkillManagementError({
            operation: "list",
            message: "Project skills could not be inspected.",
          }),
      ),
    );
    const snapshot = yield* policy.snapshot;
    const reservedNames = new Set(
      registry.catalog.releases.map((release) => release.name.toLowerCase()),
    );
    const preferences = new Map(
      catalog.projectId
        ? snapshot.projectSkills
            .filter((preference) => preference.projectId === catalog.projectId)
            .map((preference) => [preference.name, preference] as const)
        : [],
    );
    const collisions = catalog.releases.filter((release) =>
      reservedNames.has(release.name.toLowerCase()),
    );
    return {
      catalog,
      skills: catalog.releases
        .filter((release) => !reservedNames.has(release.name.toLowerCase()))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((release) => {
          const preference = preferences.get(release.name);
          return {
            releaseKey: skillReleaseKey(release),
            id: release.id,
            version: release.version,
            name: release.name,
            description: release.description,
            category: release.category,
            categoryDescription: release.categoryDescription,
            origin: release.origin,
            scope: "project" as const,
            path: `.scient/skills/${release.name}`,
            supportedScopes: [...release.supportedScopes],
            defaultInvocationPolicy: "automatic" as const,
            defaultActive: true,
            active: preference?.active ?? true,
            invocationPolicy: preference?.invocationPolicy ?? "automatic",
          };
        }),
      diagnostics: [
        ...catalog.diagnostics,
        ...collisions.map((release) => ({
          code: "project-skill-collision",
          path: `.scient/skills/${release.name}`,
          message: `Project skill '${release.name}' conflicts with a Scient-managed skill. Rename it to make it available.`,
        })),
      ],
    };
  });

  const list: ScientSkillManagementShape["list"] = Effect.fn("ScientSkillManagement.list")(
    function* (projectRoot) {
      const personal = yield* listUserSkills;
      if (!projectRoot) return personal;
      const project = yield* inspectProject(projectRoot);
      return {
        skills: [...personal.skills, ...project.skills],
        diagnostics: project.diagnostics,
        supportedProviders,
      } satisfies ScientSkillInventory;
    },
  );

  const setUserActivation: ScientSkillManagementShape["setUserActivation"] = Effect.fn(
    "ScientSkillManagement.setUserActivation",
  )(function* (input) {
    const release = registry.resolveReleaseKey(input.releaseKey);
    if (!release) {
      return yield* new ScientSkillManagementError({
        operation: "setUserActivation",
        message: "That exact skill release is not available in this Scient build.",
      });
    }
    if (!release.supportedScopes.includes("user")) {
      return yield* new ScientSkillManagementError({
        operation: "setUserActivation",
        message: "This skill cannot be made available at personal scope.",
      });
    }
    yield* policy
      .setUserSkillActivation(toSkillReleaseRef(release), input.active, input.invocationPolicy)
      .pipe(
        Effect.mapError(
          (error) =>
            new ScientSkillManagementError({
              operation: "setUserActivation",
              message: error.message,
            }),
        ),
      );
    return yield* list();
  });

  const setProjectPreference: ScientSkillManagementShape["setProjectPreference"] = Effect.fn(
    "ScientSkillManagement.setProjectPreference",
  )(function* (input) {
    const project = yield* inspectProject(input.projectRoot);
    if (!project.catalog.projectId) {
      return yield* new ScientSkillManagementError({
        operation: "setProjectPreference",
        message: "This folder is not an initialized Scient project.",
      });
    }
    if (!project.skills.some((skill) => skill.name === input.name)) {
      return yield* new ScientSkillManagementError({
        operation: "setProjectPreference",
        message: "That project skill is unavailable or invalid.",
      });
    }
    yield* policy
      .setProjectSkillPreference(
        project.catalog.projectId,
        input.name,
        input.active,
        input.invocationPolicy,
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new ScientSkillManagementError({
              operation: "setProjectPreference",
              message: error.message,
            }),
        ),
      );
    return yield* list(input.projectRoot);
  });

  return ScientSkillManagement.of({ list, setProjectPreference, setUserActivation });
});

export const layer = Layer.effect(ScientSkillManagement, make());
