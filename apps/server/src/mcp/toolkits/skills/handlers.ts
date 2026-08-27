import {
  readSkillResource,
  skillReleaseKey,
  toSkillReleaseSummary,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ScientSkillRegistry from "../../../scient/skills/ScientSkillRegistry.ts";
import { ScientSkillToolError, ScientSkillsToolkit } from "./tools.ts";

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const toolError = (
  code: ConstructorParameters<typeof ScientSkillToolError>[0]["code"],
  message: string,
) => new ScientSkillToolError({ code, message });

const requireSkillScope = Effect.fn("ScientSkillsToolkit.requireSkillScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("skills:read") || !invocation.skillScope) {
    return yield* toolError(
      "capability-unavailable",
      "This provider cannot receive Scient skills.",
    );
  }
  return invocation.skillScope;
});

function summary(release: SkillRelease, invocationPolicy: "automatic" | "explicit") {
  return {
    releaseKey: skillReleaseKey(release),
    ...toSkillReleaseSummary(release),
    invocationPolicy,
  };
}

const resolveAllowedRelease = Effect.fn("ScientSkillsToolkit.resolveAllowedRelease")(function* (
  requestedName: string,
) {
  const skillScope = yield* requireSkillScope();
  const matches = skillScope.skills.filter((skill) => skill.name === requestedName);
  if (matches.length === 0) {
    return yield* toolError(
      "not-found",
      "No Scient skill with that name is available in this turn. Call scient_skills_list once and retry with an exact returned name.",
    );
  }
  if (matches.length > 1) {
    return yield* toolError(
      "ambiguous-name",
      "That skill name is ambiguous in this Scient turn and cannot be loaded safely.",
    );
  }
  const descriptor = matches[0]!;
  if (!skillScope.releaseKeys.has(descriptor.releaseKey)) {
    return yield* toolError("not-found", "That skill is not indexed in this Scient turn.");
  }
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const release = registry.resolveReleaseKey(descriptor.releaseKey);
  if (!release) {
    return yield* toolError(
      "not-found",
      "That exact skill release is no longer available in this Scient build.",
    );
  }
  return { release, invocationPolicy: descriptor.invocationPolicy };
});

export const listScientSkillsForInvocation = Effect.fn("ScientSkillsToolkit.list")(function* () {
  const skillScope = yield* requireSkillScope();
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const policyByReleaseKey = new Map(
    skillScope.skills.map((skill) => [skill.releaseKey, skill.invocationPolicy] as const),
  );
  const skills = [...skillScope.releaseKeys]
    .map((releaseKey) => {
      const release = registry.resolveReleaseKey(releaseKey);
      const invocationPolicy = policyByReleaseKey.get(releaseKey);
      return release && invocationPolicy ? { release, invocationPolicy } : undefined;
    })
    .filter(
      (
        entry,
      ): entry is {
        readonly release: SkillRelease;
        readonly invocationPolicy: "automatic" | "explicit";
      } => entry !== undefined,
    )
    .sort(
      (left, right) =>
        compareStrings(left.release.name, right.release.name) ||
        compareStrings(left.release.id, right.release.id),
    )
    .map(({ release, invocationPolicy }) => summary(release, invocationPolicy));
  return { skills };
});

export const loadScientSkillForInvocation = Effect.fn("ScientSkillsToolkit.load")(
  function* (input: { readonly name: string }) {
    const { release, invocationPolicy } = yield* resolveAllowedRelease(input.name);
    return {
      skill: summary(release, invocationPolicy),
      instructions: release.instructions,
      resources: release.resources,
    };
  },
);

function encodeResource(bytes: Uint8Array): {
  readonly encoding: "base64" | "utf8";
  readonly content: string;
} {
  try {
    return { encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { encoding: "base64", content: Buffer.from(bytes).toString("base64") };
  }
}

export const readScientSkillResourceForInvocation = Effect.fn("ScientSkillsToolkit.readResource")(
  function* (input: { readonly name: string; readonly path: string }) {
    const { release } = yield* resolveAllowedRelease(input.name);
    const bytes = readSkillResource(release, input.path);
    if (!bytes) {
      return yield* toolError(
        "resource-unavailable",
        "That resource is not part of the selected immutable skill release.",
      );
    }
    return { path: input.path, ...encodeResource(bytes) };
  },
);

const handlers = {
  scient_skills_list: listScientSkillsForInvocation,
  scient_skill_load: loadScientSkillForInvocation,
  scient_skill_read_resource: readScientSkillResourceForInvocation,
} satisfies Parameters<typeof ScientSkillsToolkit.toLayer>[0];

export const ScientSkillsToolkitHandlersLive = ScientSkillsToolkit.toLayer(handlers);
