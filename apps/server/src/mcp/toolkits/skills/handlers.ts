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
      "This provider session has no active Scient skills.",
    );
  }
  return invocation.skillScope;
});

function summary(release: SkillRelease) {
  return { releaseKey: skillReleaseKey(release), ...toSkillReleaseSummary(release) };
}

const resolveAllowedRelease = Effect.fn("ScientSkillsToolkit.resolveAllowedRelease")(function* (
  requestedReleaseKey: string,
) {
  const scope = yield* requireSkillScope();
  if (!scope.releaseKeys.has(requestedReleaseKey)) {
    return yield* toolError(
      "not-found",
      "That exact skill release is not active in this Scient session.",
    );
  }
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const release = registry.resolveReleaseKey(requestedReleaseKey);
  if (!release) {
    return yield* toolError(
      "not-found",
      "That exact skill release is no longer available in this Scient build.",
    );
  }
  return release;
});

export const listScientSkillsForInvocation = Effect.fn("ScientSkillsToolkit.list")(function* () {
  const scope = yield* requireSkillScope();
  const registry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const skills = [...scope.releaseKeys]
    .map((releaseKey) => registry.resolveReleaseKey(releaseKey))
    .filter((release): release is SkillRelease => release !== undefined)
    .sort(
      (left, right) => compareStrings(left.name, right.name) || compareStrings(left.id, right.id),
    )
    .map(summary);
  return { skills };
});

export const loadScientSkillForInvocation = Effect.fn("ScientSkillsToolkit.load")(
  function* (input: { readonly releaseKey: string }) {
    const release = yield* resolveAllowedRelease(input.releaseKey);
    return {
      skill: summary(release),
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
  function* (input: { readonly releaseKey: string; readonly path: string }) {
    const release = yield* resolveAllowedRelease(input.releaseKey);
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
