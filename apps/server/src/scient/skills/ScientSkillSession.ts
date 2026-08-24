import {
  readProjectSkillLock,
  resolveExactSkillRelease,
  skillReleaseKey,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScientSkillPolicy from "./ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "./ScientSkillRegistry.ts";

/** Every built-in provider has an explicit delivery decision. */
export const SCIENT_SKILL_DELIVERY = {
  antigravity: "unsupported",
  claudeAgent: "mcp",
  codex: "mcp",
  cursor: "mcp",
  droid: "mcp",
  grok: "mcp",
  opencode: "mcp",
} as const;

/** Unknown future drivers fail closed until their transport is reviewed. */
export const scientSkillDeliveryForProvider = (
  provider: ProviderDriverKind,
): "mcp" | "unsupported" =>
  SCIENT_SKILL_DELIVERY[String(provider) as keyof typeof SCIENT_SKILL_DELIVERY] ?? "unsupported";

export interface ScientSkillSessionDiagnostic {
  readonly code:
    | "activation-scope-mismatch"
    | "project-lock-invalid"
    | "project-lock-untrusted"
    | "provider-unsupported"
    | "release-unavailable";
  readonly message: string;
}

export interface ScientSkillSessionPlan {
  readonly delivery: "mcp" | "none" | "unsupported";
  readonly projectRoot?: string;
  readonly releaseKeys: ReadonlySet<string>;
  readonly diagnostics: ReadonlyArray<ScientSkillSessionDiagnostic>;
}

export interface ScientSkillSessionPlannerShape {
  readonly resolve: (input: {
    readonly provider: ProviderDriverKind;
    readonly projectRoot?: string;
  }) => Effect.Effect<ScientSkillSessionPlan>;
}

/** Default remains inert for tests and non-Scient compositions. */
export class ScientSkillSessionPlanner extends Context.Reference<ScientSkillSessionPlannerShape>(
  "t3/scient/skills/ScientSkillSessionPlanner",
  {
    defaultValue: () => ({
      resolve: () => Effect.succeed({ delivery: "none", releaseKeys: new Set(), diagnostics: [] }),
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
    if (release.activationScope !== expectedScope) {
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
    const snapshot = yield* policy.snapshot;
    const diagnostics: ScientSkillSessionDiagnostic[] = [];
    const releases = new Map<string, SkillRelease>();
    for (const reference of snapshot.userSkills) {
      const release = resolveRelease(reference, "user", diagnostics);
      if (release) releases.set(skillReleaseKey(release), release);
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
            if (release) releases.set(skillReleaseKey(release), release);
          }
        }
      }
    }

    if (releases.size === 0) {
      return {
        delivery: "none" as const,
        ...(projectRoot ? { projectRoot } : {}),
        releaseKeys: new Set<string>(),
        diagnostics,
      };
    }
    if (scientSkillDeliveryForProvider(input.provider) === "unsupported") {
      diagnostics.push({
        code: "provider-unsupported",
        message: `Scient skills are not yet deliverable to provider '${input.provider}'.`,
      });
      return {
        delivery: "unsupported" as const,
        ...(projectRoot ? { projectRoot } : {}),
        releaseKeys: new Set<string>(),
        diagnostics,
      };
    }
    return {
      delivery: "mcp" as const,
      ...(projectRoot ? { projectRoot } : {}),
      releaseKeys: new Set(releases.keys()),
      diagnostics,
    };
  });

  return ScientSkillSessionPlanner.of({ resolve });
});

export const layer = Layer.effect(ScientSkillSessionPlanner, make());

export const live = layer.pipe(
  Layer.provideMerge(Layer.merge(ScientSkillRegistry.layer, ScientSkillPolicy.layer)),
);
