import {
  loadProjectSkillCatalog,
  readProjectSkillLock,
  resolveExactSkillRelease,
  skillReleaseKey,
  type ProjectSkillCatalog,
  type SkillInvocationPolicy,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AgentSkillCatalogStatus } from "../operations/AgentInvocationContext.ts";
import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";
import { resolveEffectiveUserSkillPolicies } from "./ScientSkillEffectivePolicy.ts";

/**
 * Every built-in provider has an explicit MCP transport decision. This is
 * deliberately independent of private application awareness: a provider can
 * browse the tools or load a user-selected `$skill` without Scient claiming
 * that spontaneous discovery has been qualified.
 */
export const SCIENT_SKILL_DELIVERY = {
  antigravity: "mcp",
  claudeAgent: "mcp",
  codex: "mcp",
  cursor: "mcp",
  droid: "mcp",
  grok: "mcp",
  opencode: "mcp",
  omp: "unsupported",
  pi: "mcp",
} as const;

/** Unknown future drivers fail closed until their transport is reviewed. */
export const scientSkillDeliveryForProvider = (
  provider: ProviderDriverKind,
): "mcp" | "unsupported" =>
  SCIENT_SKILL_DELIVERY[String(provider) as keyof typeof SCIENT_SKILL_DELIVERY] ?? "unsupported";

export interface ScientSkillSessionDiagnostic {
  readonly code:
    | "activation-scope-mismatch"
    | "invocation-name-conflict"
    | "project-lock-invalid"
    | "project-lock-untrusted"
    | "project-skill-collision"
    | "project-skill-invalid"
    | "provider-unsupported"
    | "release-unavailable";
  readonly message: string;
}

export interface ScientSkillSessionPlan {
  readonly delivery: "mcp" | "none" | "unsupported";
  readonly catalogStatus: Exclude<AgentSkillCatalogStatus, "pending">;
  readonly projectRoot?: string;
  readonly releases: ReadonlyMap<string, SkillRelease>;
  readonly skills: ReadonlyArray<ScientSkillSessionSkill>;
  readonly diagnostics: ReadonlyArray<ScientSkillSessionDiagnostic>;
}

export interface ScientSkillSessionSkill {
  readonly releaseKey: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly origin: string;
  readonly activationScope: "project" | "user";
  readonly invocationPolicy: SkillInvocationPolicy;
}

export interface ScientSkillSessionPlannerShape {
  readonly resolve: (input: {
    readonly provider: ProviderDriverKind;
    readonly projectRoot?: string;
    /** Whether this exact configured adapter can attach the host-issued MCP
     * session. Provider kind alone is insufficient for external runtimes. */
    readonly mcpSessionAvailable?: boolean;
  }) => Effect.Effect<ScientSkillSessionPlan>;
}

/** Default remains inert for tests and non-Scient compositions. */
export class ScientSkillSessionPlanner extends Context.Reference<ScientSkillSessionPlannerShape>(
  "t3/scient/skills/ScientSkillSessionPlanner",
  {
    defaultValue: () => ({
      resolve: () =>
        Effect.succeed({
          delivery: "none",
          catalogStatus: "complete",
          releases: new Map(),
          skills: [],
          diagnostics: [],
        }),
    }),
  },
) {}

const make = Effect.fn("ScientSkillSessionPlanner.make")(function* () {
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const policy = yield* ScientSkillPolicy.ScientSkillPolicy;

  const resolveRelease = (
    reference: Parameters<typeof resolveExactSkillRelease>[1],
    expectedScope: "project" | "user",
    diagnostics: ScientSkillSessionDiagnostic[],
  ): SkillRelease | undefined => {
    const release = resolveExactSkillRelease(registry.catalog, reference);
    if (!release) {
      diagnostics.push({
        code: "release-unavailable",
        message: `Exact skill release '${reference.id}@${reference.version}' is unavailable.`,
      });
      return undefined;
    }
    if (!release.supportedScopes.includes(expectedScope)) {
      diagnostics.push({
        code: "activation-scope-mismatch",
        message: `Skill '${release.id}' cannot be activated at ${expectedScope} scope.`,
      });
      return undefined;
    }
    return release;
  };

  const resolve: ScientSkillSessionPlannerShape["resolve"] = Effect.fn(
    "ScientSkillSessionPlanner.resolve",
  )(function* (input) {
    const { snapshot, snapshotIsComplete } = yield* policy.readState;
    const diagnostics: ScientSkillSessionDiagnostic[] = [];
    let projectCatalogReadFailed = false;
    const releases = new Map<
      string,
      {
        readonly release: SkillRelease;
        readonly activationScope: "project" | "user";
        readonly invocationPolicy: SkillInvocationPolicy;
      }
    >();
    for (const effective of resolveEffectiveUserSkillPolicies(registry, snapshot)) {
      if (!effective.active) continue;
      releases.set(skillReleaseKey(effective.release), {
        release: effective.release,
        activationScope: "user",
        invocationPolicy: effective.invocationPolicy,
      });
    }

    let projectRoot: string | undefined;
    if (input.projectRoot) {
      const requestedProjectRoot = input.projectRoot;
      const lock = yield* Effect.tryPromise(() => readProjectSkillLock(requestedProjectRoot)).pipe(
        Effect.orElseSucceed(() => ({
          status: "invalid" as const,
          rootPath: requestedProjectRoot,
          message: "Project skill lock could not be read.",
        })),
      );
      projectRoot = lock.rootPath;
      if (lock.status === "invalid") {
        diagnostics.push({ code: "project-lock-invalid", message: lock.message });
      } else if (lock.status === "valid") {
        const trusted = snapshot.trustedProjects.some(
          (receipt) =>
            receipt.projectId === lock.projectId &&
            receipt.rootPath === lock.rootPath &&
            receipt.lockDigest === lock.lockDigest,
        );
        if (!trusted) {
          diagnostics.push({
            code: "project-lock-untrusted",
            message: "Project skill activation is withheld until this exact lock is trusted.",
          });
        } else {
          for (const reference of lock.lock.skills) {
            const release = resolveRelease(reference, "project", diagnostics);
            if (release) {
              const key = skillReleaseKey(release);
              if (!releases.has(key)) {
                releases.set(key, {
                  release,
                  activationScope: "project",
                  invocationPolicy: release.defaultInvocationPolicy,
                });
              }
            }
          }
        }
      }

      const projectCatalog: ProjectSkillCatalog = yield* Effect.tryPromise(() =>
        loadProjectSkillCatalog(requestedProjectRoot),
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            projectCatalogReadFailed = true;
            return {
              rootPath: requestedProjectRoot,
              releases: [],
              diagnostics: [
                {
                  code: "invalid-project" as const,
                  path: ".scient/skills",
                  message: "Project skills could not be inspected.",
                },
              ],
            } satisfies ProjectSkillCatalog;
          }),
        ),
      );
      projectRoot = projectCatalog.rootPath;
      for (const diagnostic of projectCatalog.diagnostics) {
        // Ordinary T3 projects are valid workspaces but have no Scient identity
        // and therefore no project-skill namespace. That expected state is
        // silent during turns; management surfaces may still explain it.
        if (diagnostic.code === "not-initialized-project") continue;
        diagnostics.push({
          code: "project-skill-invalid",
          message: `${diagnostic.path}: ${diagnostic.message}`,
        });
      }
      if (projectCatalog.projectId) {
        const preferences = new Map(
          snapshot.projectSkills
            .filter((preference) => preference.projectId === projectCatalog.projectId)
            .map((preference) => [preference.name, preference] as const),
        );
        const reservedNames = new Set(
          registry.catalog.releases.map((release) => release.name.toLowerCase()),
        );
        for (const release of projectCatalog.releases) {
          if (reservedNames.has(release.name.toLowerCase())) {
            diagnostics.push({
              code: "project-skill-collision",
              message: `Project skill '${release.name}' conflicts with a Scient-managed skill and was withheld. Rename the project skill.`,
            });
            continue;
          }
          const preference = preferences.get(release.name);
          if (preference?.active === false) continue;
          releases.set(skillReleaseKey(release), {
            release,
            activationScope: "project",
            invocationPolicy: preference?.invocationPolicy ?? "automatic",
          });
        }
      }
    }

    const catalogStatus = (): Exclude<AgentSkillCatalogStatus, "pending"> =>
      !snapshotIsComplete ||
      registry.catalog.diagnostics.length > 0 ||
      projectCatalogReadFailed ||
      diagnostics.some(
        ({ code }) => code !== "project-lock-untrusted" && code !== "provider-unsupported",
      )
        ? "incomplete"
        : "complete";

    if (releases.size === 0) {
      return {
        delivery: "none" as const,
        catalogStatus: catalogStatus(),
        ...(projectRoot ? { projectRoot } : {}),
        releases: new Map<string, SkillRelease>(),
        skills: [],
        diagnostics,
      };
    }
    if (
      input.mcpSessionAvailable === false ||
      scientSkillDeliveryForProvider(input.provider) === "unsupported"
    ) {
      diagnostics.push({
        code: "provider-unsupported",
        message: `Scient skills are not deliverable to this '${input.provider}' provider session.`,
      });
      return {
        delivery: "unsupported" as const,
        catalogStatus: "incomplete" as const,
        ...(projectRoot ? { projectRoot } : {}),
        releases: new Map<string, SkillRelease>(),
        skills: [],
        diagnostics,
      };
    }
    const candidates = [...releases.entries()]
      .map(([releaseKey, activation]) => ({
        releaseKey,
        id: activation.release.id,
        name: activation.release.name,
        description: activation.release.description,
        origin: activation.release.origin,
        activationScope: activation.activationScope,
        invocationPolicy: activation.invocationPolicy,
      }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    const nameCounts = new Map<string, number>();
    for (const skill of candidates) {
      nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
    }
    const conflictingNames = [...nameCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort();
    for (const name of conflictingNames) {
      diagnostics.push({
        code: "invocation-name-conflict",
        message: `Skill name '${name}' identifies more than one active release and was withheld.`,
      });
    }
    const skills = candidates.filter((skill) => nameCounts.get(skill.name) === 1);
    if (skills.length === 0) {
      return {
        delivery: "none" as const,
        catalogStatus: catalogStatus(),
        ...(projectRoot ? { projectRoot } : {}),
        releases: new Map<string, SkillRelease>(),
        skills: [],
        diagnostics,
      };
    }
    return {
      delivery: "mcp" as const,
      catalogStatus: catalogStatus(),
      ...(projectRoot ? { projectRoot } : {}),
      releases: new Map(
        skills.map((skill) => [skill.releaseKey, releases.get(skill.releaseKey)!.release]),
      ),
      skills,
      diagnostics,
    };
  });

  return ScientSkillSessionPlanner.of({ resolve });
});

export const layer = Layer.effect(ScientSkillSessionPlanner, make());

export const live = layer.pipe(
  Layer.provideMerge(Layer.merge(ScientSkillRegistry.layer, ScientSkillPolicy.layer)),
);
