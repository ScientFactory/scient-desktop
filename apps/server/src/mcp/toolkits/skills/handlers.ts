import {
  readSkillResource,
  skillReleaseKey,
  toSkillReleaseSummary,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ScientSkillToolError, ScientSkillsToolkit, type ScientSkillListInput } from "./tools.ts";

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const toolError = (
  code: ConstructorParameters<typeof ScientSkillToolError>[0]["code"],
  message: string,
) => new ScientSkillToolError({ code, message });

const requireSkillScope = Effect.fn("ScientSkillsToolkit.requireSkillScope")(function* () {
  const invocation = yield* AgentInvocationContext.AgentInvocationContext;
  if (!invocation.capabilities.has("skills:read") || !invocation.skillScope) {
    return yield* toolError(
      "capability-unavailable",
      "This provider cannot receive Scient skills.",
    );
  }
  return invocation.skillScope;
});

function summary(
  release: SkillRelease,
  invocationPolicy: "automatic" | "explicit",
  activationScope: "project" | "user",
) {
  return {
    releaseKey: skillReleaseKey(release),
    ...toSkillReleaseSummary(release),
    activationScope,
    invocationPolicy,
  };
}

const resolveAllowedRelease = Effect.fn("ScientSkillsToolkit.resolveAllowedRelease")(function* (
  requestedName: string,
) {
  const skillScope = yield* requireSkillScope();
  if (skillScope.catalog?.status === "pending") {
    return yield* toolError(
      "not-found",
      "The Scient skill scope is not prepared yet. Retry after this turn starts.",
    );
  }
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
  const release = skillScope.releases.get(descriptor.releaseKey);
  if (!release) {
    return yield* toolError(
      "not-found",
      "That exact skill release is not available in this Scient turn.",
    );
  }
  return {
    release,
    activationScope: descriptor.activationScope,
    invocationPolicy: descriptor.invocationPolicy,
  };
});

export const listScientSkillsForInvocation = Effect.fn("ScientSkillsToolkit.list")(function* (
  input: ScientSkillListInput = {},
) {
  const skillScope = yield* requireSkillScope();
  const scope = skillScope.catalog ?? { status: "pending" as const };
  if (scope.status === "pending") {
    return {
      skills: [],
      total: 0,
      nextOffset: null,
      scope: { status: "pending" as const, includesAllSkills: false },
      hint: "The Scient skill scope has not been prepared for this turn. This is not evidence that no skills are available; retry discovery after turn setup.",
    };
  }
  const descriptorByReleaseKey = new Map(
    skillScope.skills.map((skill) => [skill.releaseKey, skill] as const),
  );
  const skills = [...skillScope.releases.entries()]
    .map(([releaseKey, release]) => {
      const descriptor = descriptorByReleaseKey.get(releaseKey);
      return descriptor ? { release, descriptor } : undefined;
    })
    .filter(
      (
        entry,
      ): entry is {
        readonly release: SkillRelease;
        readonly descriptor: AgentInvocationContext.AgentSkillDescriptor;
      } => entry !== undefined,
    )
    .sort(
      (left, right) =>
        compareStrings(left.release.name, right.release.name) ||
        compareStrings(left.release.id, right.release.id),
    )
    .map(({ release, descriptor }) => ({
      name: release.name,
      description: release.description,
      origin: release.origin,
      invocationPolicy: descriptor.invocationPolicy,
    }));
  const terms = (input.query ?? "").trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matched = skills.filter((skill) =>
    terms.every((term) => `${skill.name} ${skill.description}`.toLowerCase().includes(term)),
  );
  // A lexical miss is not evidence that useful guidance is unavailable. Keep
  // recovery bounded and explicit rather than relying on another guessed query.
  const browseFallback = terms.length > 0 && matched.length === 0 && skills.length > 0;
  const matches = browseFallback ? skills : matched;
  const offset = input.offset ?? 0;
  const page = matches.slice(offset, offset + (input.limit ?? 20));
  const nextOffset = offset + page.length < matches.length ? offset + page.length : null;
  const includesAllSkills =
    scope.status === "complete" && terms.length === 0 && offset === 0 && nextOffset === null;
  const hint =
    scope.status === "incomplete"
      ? "Scient skill discovery was incomplete for this turn. Results may be partial, and an empty result does not establish that no Scient skills are available. Retry discovery after a new turn scope is prepared."
      : skills.length === 0
        ? "No Scient skills are available in this prepared turn scope."
        : browseFallback
          ? "No keyword matches; showing available skills to browse instead. Load any applicable skill by name. Pagination uses this browse order."
          : undefined;
  return {
    skills: page,
    total: matches.length,
    nextOffset,
    scope: {
      status: scope.status,
      ...(scope.digest ? { digest: scope.digest } : {}),
      includesAllSkills,
    },
    ...(hint ? { hint } : {}),
  };
});

export const loadScientSkillForInvocation = Effect.fn("ScientSkillsToolkit.load")(
  function* (input: { readonly name: string }) {
    const { release, activationScope, invocationPolicy } = yield* resolveAllowedRelease(input.name);
    return {
      skill: summary(release, invocationPolicy, activationScope),
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
