import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  getBuiltInSkillReadiness,
  listUserActivatedBuiltInSkillReleases,
  listUserFacingBuiltInSkillReleases,
  type BuiltInSkillRelease,
} from "@scientfactory/scient-skills";
import type { ScientBuiltInSkillCatalogEntry, ServerSettings } from "@synara/contracts";
import { Effect } from "effect";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const ACTIVE_BUILT_IN_SKILLS_DIRECTORY = "scient-built-in-skills";
const MANIFEST_FILE = ".managed-releases.json";
const synchronizationTails = new Map<string, Promise<void>>();

interface ManagedBuiltInSkillsManifest {
  readonly formatVersion: 1;
  readonly directories: readonly string[];
}

function activationOverrides(settings: ServerSettings): ReadonlyMap<string, boolean> {
  return new Map(
    settings.skills.scientBuiltInActivationOverrides.map((override) => [
      override.id,
      override.enabled,
    ]),
  );
}

export function isScientBuiltInSkillEnabled(
  release: BuiltInSkillRelease,
  settings: ServerSettings,
): boolean {
  return activationOverrides(settings).get(release.id) ?? release.activation.defaultEnabled;
}

export function scientBuiltInSkillsActiveRoot(baseDir: string): string {
  return path.join(baseDir, ACTIVE_BUILT_IN_SKILLS_DIRECTORY);
}

export function scientBuiltInSkillDeliveryPath(
  baseDir: string,
  release: BuiltInSkillRelease,
): string {
  return path.join(scientBuiltInSkillsActiveRoot(baseDir), release.name, "SKILL.md");
}

export function listScientBuiltInSkillCatalogEntries(
  settings: ServerSettings,
): readonly ScientBuiltInSkillCatalogEntry[] {
  return listUserFacingBuiltInSkillReleases().map((release) => ({
    id: release.id,
    name: release.name,
    displayName: release.displayName,
    description: release.description,
    version: release.version,
    digest: release.digest,
    origin: release.origin,
    kind: release.kind,
    role: release.role,
    activationScope: release.activation.scope,
    readiness: getBuiltInSkillReadiness(release),
    enabled: release.activation.scope === "user" && isScientBuiltInSkillEnabled(release, settings),
    defaultEnabled: release.activation.defaultEnabled,
    capabilities: release.capabilities,
    limitations: release.limitations,
  }));
}

function enabledUserActivatedReleases(settings: ServerSettings): readonly BuiltInSkillRelease[] {
  return listUserActivatedBuiltInSkillReleases().filter((release) =>
    isScientBuiltInSkillEnabled(release, settings),
  );
}

function activationSignature(settings: ServerSettings): string {
  return enabledUserActivatedReleases(settings)
    .map((release) => `${release.id}@${release.version}:${release.digest}`)
    .join("\n");
}

export function haveSameScientBuiltInSkillActivation(
  left: ServerSettings,
  right: ServerSettings,
): boolean {
  return activationSignature(left) === activationSignature(right);
}

async function readManagedManifest(root: string): Promise<ManagedBuiltInSkillsManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.formatVersion !== 1 || !Array.isArray(candidate.directories)) return null;
    const directories = candidate.directories.filter(
      (entry): entry is string =>
        typeof entry === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry),
    );
    return { formatVersion: 1, directories };
  } catch {
    return null;
  }
}

async function writeFileIfChanged(target: string, contents: string): Promise<void> {
  if ((await readFile(target, "utf8").catch(() => null)) === contents) return;
  await Effect.runPromise(writeFileStringAtomically({ filePath: target, contents, mode: 0o600 }));
}

async function synchronizeScientBuiltInSkillsUnlocked(input: {
  readonly baseDir: string;
  readonly settings: ServerSettings;
}): Promise<void> {
  const root = scientBuiltInSkillsActiveRoot(input.baseDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const previousManifest = await readManagedManifest(root);
  const enabled = enabledUserActivatedReleases(input.settings);
  const enabledDirectories = new Set(enabled.map((release) => release.name));
  const knownDirectories = new Set([
    ...(previousManifest?.directories ?? []),
    ...listUserActivatedBuiltInSkillReleases().map((release) => release.name),
  ]);

  for (const directory of knownDirectories) {
    if (!enabledDirectories.has(directory)) {
      await rm(path.join(root, directory), { recursive: true, force: true });
    }
  }

  for (const release of enabled) {
    const releaseDirectory = path.join(root, release.name);
    await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
    await writeFileIfChanged(path.join(releaseDirectory, "SKILL.md"), release.body);
    await writeFileIfChanged(
      path.join(releaseDirectory, "scient.release.json"),
      `${JSON.stringify(
        {
          id: release.id,
          version: release.version,
          digest: release.digest,
          origin: release.origin,
        },
        null,
        2,
      )}\n`,
    );
  }

  await writeFileIfChanged(
    path.join(root, MANIFEST_FILE),
    `${JSON.stringify(
      {
        formatVersion: 1,
        directories: [...enabledDirectories].toSorted(),
      } satisfies ManagedBuiltInSkillsManifest,
      null,
      2,
    )}\n`,
  );
}

export function synchronizeScientBuiltInSkills(input: {
  readonly baseDir: string;
  readonly settings: ServerSettings;
}): Promise<void> {
  const root = scientBuiltInSkillsActiveRoot(input.baseDir);
  const previous = synchronizationTails.get(root) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => synchronizeScientBuiltInSkillsUnlocked(input));
  synchronizationTails.set(root, current);
  return current.finally(() => {
    if (synchronizationTails.get(root) === current) synchronizationTails.delete(root);
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildScientBuiltInSkillTriggerInstructions(input: {
  readonly baseDir: string;
  readonly settings: ServerSettings;
}): string {
  const all = listUserActivatedBuiltInSkillReleases();
  if (all.length === 0) return "";
  const enabled = enabledUserActivatedReleases(input.settings);
  if (enabled.length === 0) {
    return [
      '<scient_builtin_skills enabled="none">',
      "No Scient built-in skills are enabled. Do not invoke a Scient built-in skill, even if one appeared earlier in this conversation.",
      "</scient_builtin_skills>",
    ].join("\n");
  }

  const skillEntries = enabled.map((release) =>
    [
      `<skill id="${escapeAttribute(release.id)}" name="${escapeAttribute(release.name)}" version="${escapeAttribute(release.version)}" digest="${escapeAttribute(release.digest)}" origin="${escapeAttribute(release.origin)}" path="${escapeAttribute(scientBuiltInSkillDeliveryPath(input.baseDir, release))}">`,
      escapeAttribute(release.description),
      "</skill>",
    ].join("\n"),
  );
  return [
    '<scient_builtin_skills enabled="true">',
    "The following optional Scient skills are enabled. Compare the current work with each description. When the work matches, read that skill's SKILL.md from its exact path before proceeding and follow it. Do not read or use a skill when the work does not match. Skills omitted from this list are disabled and must not be invoked, even if they appeared earlier in this conversation.",
    ...skillEntries,
    "</scient_builtin_skills>",
  ].join("\n");
}
