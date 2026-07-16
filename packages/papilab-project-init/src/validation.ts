import path from "node:path";

import {
  PAPILAB_AGENTS_FILE,
  PAPILAB_METADATA_DIRECTORY,
  PAPILAB_PROJECT_FILE,
  ProjectInitializationError,
  type InitializationRequest,
  type PapiLabProjectIdentity,
  type NormalizedInitializationRequest,
  type ProjectProfileDescriptor,
} from "./types.ts";

const MAX_TEXT_LENGTH = 10_000;
const MAX_PROFILE_FILE_LENGTH = 1_048_576;
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
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
  for (const profileId of profileIds) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Invalid profile ID in initialization request: ${profileId}`,
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
  };
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
    segments[0] === PAPILAB_METADATA_DIRECTORY ||
    input === PAPILAB_PROJECT_FILE ||
    input === PAPILAB_AGENTS_FILE
  ) {
    throw new ProjectInitializationError(
      "INVALID_PROFILE",
      `Profiles may not replace the universal PapiLab foundation: ${input}`,
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
    const portableKey = normalizedPath.toLowerCase();
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
  return input.profileIds.map((profileId) => {
    const profile = registry.get(profileId);
    if (!profile) {
      throw new ProjectInitializationError(
        "INVALID_REQUEST",
        `Unknown project profile: ${profileId}`,
      );
    }
    return profile;
  });
}

export function validateProjectIdentity(value: unknown): PapiLabProjectIdentity {
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
      `Unsupported PapiLab project format version: ${String(candidate.formatVersion)}`,
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
