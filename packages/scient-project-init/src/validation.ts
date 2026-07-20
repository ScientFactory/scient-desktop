import path from "node:path";

import {
  LEGACY_PAPILAB_METADATA_DIRECTORY,
  SCIENT_AGENTS_FILE,
  SCIENT_BUILT_IN_ORIGIN,
  SCIENT_METADATA_DIRECTORY,
  SCIENT_PROJECT_FILE,
  SCIENT_SKILLS_LOCK_FORMAT_VERSION,
  ProjectInitializationError,
  type InitializationRequest,
  type BuiltInSkillActivation,
  type BuiltInSkillDescriptor,
  type ScientSkillsLock,
  type ScientProjectIdentity,
  type NormalizedInitializationRequest,
  type ProjectProfileDescriptor,
} from "./types.ts";

const MAX_TEXT_LENGTH = 10_000;
const MAX_PROFILE_FILE_LENGTH = 1_048_576;
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BUILT_IN_SKILL_ID_PATTERN = /^scient\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SKILL_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const WINDOWS_FORBIDDEN_NAME_CHARACTERS = /[<>:"|?*]/;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const RESERVED_PROJECT_HEADINGS = new Set(
  [
    "Purpose",
    "Main Question Or Objective",
    "Project Type And Workflow",
    "Scope",
    "Included",
    "Excluded",
    "Starting Materials",
    "Intended Outputs",
    "Constraints And Sensitivities",
    "Terminology",
    "Important Decisions",
    "Open Questions",
    "Current Status",
  ].map((heading) => heading.toLowerCase()),
);

function normalizeOptionalText(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) return null;
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `${field} must be at most ${MAX_TEXT_LENGTH} characters.`,
    );
  }
  return normalized;
}

export function normalizeInitializationRequest(
  request: InitializationRequest,
): NormalizedInitializationRequest {
  const profileIds = [...new Set(request.profileIds ?? [])];
  const skillIds = [...new Set(request.skillIds ?? [])];
  for (const profileId of profileIds) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Invalid profile ID in initialization request: ${profileId}`,
      );
    }
  }
  for (const skillId of skillIds) {
    if (!BUILT_IN_SKILL_ID_PATTERN.test(skillId)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Invalid built-in skill ID in initialization request: ${skillId}`,
      );
    }
  }
  const title = normalizeOptionalText(request.title, "Project title");
  if (title !== null && (title.length > 200 || /[\r\n]/.test(title))) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      "Project title must be a single line of at most 200 characters.",
    );
  }
  return {
    title,
    purpose: normalizeOptionalText(request.purpose, "Project purpose"),
    question: normalizeOptionalText(request.question, "Project question"),
    scopeIncluded: normalizeOptionalText(request.scopeIncluded, "Included scope"),
    scopeExcluded: normalizeOptionalText(request.scopeExcluded, "Excluded scope"),
    profileIds: profileIds.toSorted(),
    skillIds: skillIds.toSorted(),
  };
}

export function validateSkillsLock(value: unknown): ScientSkillsLock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectInitializationError("INVALID_REQUEST", "Skills lock must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== SCIENT_SKILLS_LOCK_FORMAT_VERSION) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Unsupported skills lock format version: ${String(candidate.formatVersion)}`,
    );
  }
  if (!Array.isArray(candidate.skills)) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      "Skills lock entries must be an array.",
    );
  }
  const seen = new Set<string>();
  const skills = candidate.skills.map((value): BuiltInSkillActivation => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProjectInitializationError("INVALID_REQUEST", "Invalid skills lock entry.");
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || !BUILT_IN_SKILL_ID_PATTERN.test(entry.id)) {
      throw new ProjectInitializationError("INVALID_REQUEST", "Invalid built-in skill identity.");
    }
    if (seen.has(entry.id)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Skills lock repeats built-in identity ${entry.id}.`,
      );
    }
    seen.add(entry.id);
    if (typeof entry.version !== "string" || !SKILL_VERSION_PATTERN.test(entry.version)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Invalid built-in skill version for ${entry.id}.`,
      );
    }
    if (typeof entry.digest !== "string" || !SKILL_DIGEST_PATTERN.test(entry.digest)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Invalid built-in skill digest for ${entry.id}.`,
      );
    }
    if (entry.origin !== SCIENT_BUILT_IN_ORIGIN) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Invalid built-in skill origin for ${entry.id}.`,
      );
    }
    return {
      id: entry.id,
      version: entry.version,
      digest: entry.digest as `sha256:${string}`,
      origin: SCIENT_BUILT_IN_ORIGIN,
    };
  });
  return {
    formatVersion: SCIENT_SKILLS_LOCK_FORMAT_VERSION,
    skills: skills.toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

export function resolveSelectedBuiltInSkills(input: {
  readonly skillIds: readonly string[];
  readonly skills: readonly BuiltInSkillDescriptor[];
}): readonly BuiltInSkillDescriptor[] {
  const registry = new Map<string, BuiltInSkillDescriptor>();
  for (const skill of input.skills) {
    validateBuiltInSkillDescriptor(skill);
    if (registry.has(skill.id)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Duplicate built-in skill descriptor: ${skill.id}`,
      );
    }
    registry.set(skill.id, skill);
  }
  return input.skillIds.map((skillId) => {
    const skill = registry.get(skillId);
    if (!skill) {
      throw new ProjectInitializationError("INVALID_REQUEST", `Unknown built-in skill: ${skillId}`);
    }
    return skill;
  });
}

function validateBuiltInSkillDescriptor(skill: BuiltInSkillDescriptor): void {
  validateSkillsLock({
    formatVersion: SCIENT_SKILLS_LOCK_FORMAT_VERSION,
    skills: [skill],
  });
  if (skill.displayName.trim().length === 0 || skill.displayName.length > 120) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Built-in skill ${skill.id} has an invalid display name.`,
    );
  }
  if (skill.description.trim().length === 0 || skill.description.length > 1_024) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Built-in skill ${skill.id} has an invalid description.`,
    );
  }
  if (!["constructive", "review", "orientation"].includes(skill.role)) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Built-in skill ${skill.id} has an invalid role.`,
    );
  }
  if (typeof skill.defaultSelected !== "boolean") {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Built-in skill ${skill.id} has an invalid default selection.`,
    );
  }
  if (!["available", "latent"].includes(skill.readiness)) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Built-in skill ${skill.id} has invalid readiness.`,
    );
  }
  for (const prerequisite of skill.prerequisites) {
    if (prerequisite.trim().length === 0 || prerequisite.length > 240) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Built-in skill ${skill.id} has an invalid prerequisite.`,
      );
    }
  }
  if (
    typeof skill.capabilities.network !== "boolean" ||
    typeof skill.capabilities.codeExecution !== "boolean" ||
    !["none", "proposal-only"].includes(skill.capabilities.projectWrites)
  ) {
    throw new ProjectInitializationError(
      "INVALID_REQUEST",
      `Built-in skill ${skill.id} has invalid capabilities.`,
    );
  }
}

export function validatePortableRelativePath(input: string): string {
  if (input.includes("\0") || input.includes("\\")) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profile file path must use portable forward slashes: ${input}`,
    );
  }
  if (input.length === 0 || input.length > 240 || path.posix.isAbsolute(input)) {
    throw new ProjectInitializationError("INVALID_PROFILE", `Invalid profile file path: ${input}`);
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ProjectInitializationError("INVALID_PROFILE", `Invalid profile file path: ${input}`);
  }
  if (
    segments.some(
      (segment) =>
        WINDOWS_FORBIDDEN_NAME_CHARACTERS.test(segment) ||
        [...segment].some((character) => character.codePointAt(0)! < 32) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_BASENAME.test(segment),
    )
  ) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profile file path is not portable across supported filesystems: ${input}`,
    );
  }
  const portableInput = input.normalize("NFC").toLowerCase();
  if (
    segments[0]?.normalize("NFC").toLowerCase() === SCIENT_METADATA_DIRECTORY ||
    segments[0]?.normalize("NFC").toLowerCase() === LEGACY_PAPILAB_METADATA_DIRECTORY ||
    portableInput === SCIENT_PROJECT_FILE.toLowerCase() ||
    portableInput === SCIENT_AGENTS_FILE.toLowerCase()
  ) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profiles may not replace the universal Scient foundation: ${input}`,
    );
  }
  return input;
}

export function validateProfileDescriptor(
  descriptor: ProjectProfileDescriptor,
): ProjectProfileDescriptor {
  if (!PROFILE_ID_PATTERN.test(descriptor.id)) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profile ID must be lowercase kebab case: ${descriptor.id}`,
    );
  }
  if (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profile ${descriptor.id} must have a positive integer version.`,
    );
  }
  if (descriptor.displayName.trim().length === 0 || descriptor.displayName.length > 120) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profile ${descriptor.id} has an invalid display name.`,
    );
  }

  const headings = new Set<string>();
  for (const section of descriptor.projectSections ?? []) {
    const heading = section.heading.trim();
    if (heading.length === 0 || heading.length > 120 || /[\r\n]/.test(heading)) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profile ${descriptor.id} has an invalid project section heading.`,
      );
    }
    if (headings.has(heading.toLowerCase())) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profile ${descriptor.id} repeats project section ${heading}.`,
      );
    }
    if (RESERVED_PROJECT_HEADINGS.has(heading.toLowerCase())) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profile ${descriptor.id} may not repeat universal section ${heading}.`,
      );
    }
    headings.add(heading.toLowerCase());
    normalizeOptionalText(section.prompt, `Profile ${descriptor.id} section prompt`);
  }

  for (const instruction of descriptor.managedAgentInstructions ?? []) {
    const normalized = normalizeOptionalText(
      instruction,
      `Profile ${descriptor.id} agent instruction`,
    );
    if (normalized === null || normalized.length > 500 || /[\r\n]/.test(normalized)) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profile ${descriptor.id} agent instructions must be single lines of at most 500 characters.`,
      );
    }
  }

  const filePaths = new Set<string>();
  for (const file of descriptor.files ?? []) {
    const normalizedPath = validatePortableRelativePath(file.path);
    const portableKey = normalizedPath.normalize("NFC").toLowerCase();
    if (filePaths.has(portableKey)) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profile ${descriptor.id} repeats file ${normalizedPath}.`,
      );
    }
    filePaths.add(portableKey);
    if (Buffer.byteLength(file.contents, "utf8") > MAX_PROFILE_FILE_LENGTH) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Profile file ${normalizedPath} exceeds ${MAX_PROFILE_FILE_LENGTH} bytes.`,
      );
    }
  }

  return descriptor;
}

export function resolveSelectedProfiles(input: {
  readonly profileIds: readonly string[];
  readonly profiles: readonly ProjectProfileDescriptor[];
}): readonly ProjectProfileDescriptor[] {
  const registry = new Map<string, ProjectProfileDescriptor>();
  for (const candidate of input.profiles) {
    const profile = validateProfileDescriptor(candidate);
    if (registry.has(profile.id)) {
      throw new ProjectInitializationError(
        "INVALID_PROFILE",
        `Duplicate profile descriptor: ${profile.id}`,
      );
    }
    registry.set(profile.id, profile);
  }
  const selected = input.profileIds.map((profileId) => {
    const profile = registry.get(profileId);
    if (!profile) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Unknown project profile: ${profileId}`,
      );
    }
    return profile;
  });
  const sectionOwners = new Map<string, string>();
  for (const profile of selected) {
    for (const section of profile.projectSections ?? []) {
      const sectionKey = section.heading.trim().normalize("NFC").toLowerCase();
      const existingOwner = sectionOwners.get(sectionKey);
      if (existingOwner) {
        throw new ProjectInitializationError(
          "INVALID_PROFILE",
          `Profiles ${existingOwner} and ${profile.id} both define project section ${section.heading.trim()}.`,
        );
      }
      sectionOwners.set(sectionKey, profile.id);
    }
  }
  return selected;
}

export function validateProjectIdentity(value: unknown): ScientProjectIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectInitializationError("INVALID_IDENTITY", "Project identity must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.projectId !== "string" || !PROJECT_ID_PATTERN.test(candidate.projectId)) {
    throw new ProjectInitializationError("INVALID_IDENTITY", "Project identity has an invalid ID.");
  }
  if (candidate.formatVersion !== 1) {
    throw new ProjectInitializationError(
      "INVALID_IDENTITY",
      `Unsupported Scient project format version: ${String(candidate.formatVersion)}`,
    );
  }
  if (
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    new Date(candidate.createdAt).toISOString() !== candidate.createdAt
  ) {
    throw new ProjectInitializationError(
      "INVALID_IDENTITY",
      "Project identity has an invalid creation time.",
    );
  }
  return {
    projectId: candidate.projectId,
    formatVersion: 1,
    createdAt: candidate.createdAt,
  };
}

export function assertIsoTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ProjectInitializationError(
      "INVALID_PLAN",
      `Expected an ISO-8601 UTC timestamp, received ${value}.`,
    );
  }
  return value;
}

export function assertProjectId(value: string): string {
  if (!PROJECT_ID_PATTERN.test(value)) {
    throw new ProjectInitializationError("INVALID_PLAN", `Invalid project ID: ${value}`);
  }
  return value;
}
