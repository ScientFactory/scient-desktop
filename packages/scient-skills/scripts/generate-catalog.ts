import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "oxfmt";

import {
  assertBuiltInSkillMetadata,
  compareBuiltInSkillVersions,
  computeBuiltInSkillDigest,
  parseSkillFrontmatter,
} from "../src/validate.ts";
import {
  SCIENT_BUILT_IN_ORIGIN,
  type BuiltInSkillRelease,
  type BuiltInSkillTextAsset,
} from "../src/types.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(packageRoot, "skills");
const generatedPath = path.join(packageRoot, "src", "generated.ts");

async function readUtf8Asset(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`Built-in skill asset ${filePath} must be valid UTF-8 text.`);
  }
}

async function collectAssetDirectory(
  directory: string,
  relativeDirectory: string,
): Promise<BuiltInSkillTextAsset[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets: BuiltInSkillTextAsset[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `${relativeDirectory}/${entry.name}` as `assets/${string}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...(await collectAssetDirectory(absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Built-in skill asset ${relativePath} must be a regular file.`);
    }
    assets.push({ path: relativePath, contents: await readUtf8Asset(absolutePath) });
  }
  return assets;
}

async function collectReleaseAssets(directory: string): Promise<BuiltInSkillTextAsset[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets: BuiltInSkillTextAsset[] = [];
  for (const entry of entries) {
    if (entry.name === "SKILL.md" || entry.name === "scient.skill.json") continue;
    if (!entry.isDirectory() || entry.name !== "assets") {
      throw new Error(
        `Built-in skill release entry ${entry.name} must be SKILL.md, scient.skill.json, or assets/.`,
      );
    }
    assets.push(...(await collectAssetDirectory(path.join(directory, entry.name), entry.name)));
  }
  return assets.toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function buildBuiltInSkillReleases(): Promise<readonly BuiltInSkillRelease[]> {
  const skillDirectories = await directoryNames(skillsRoot);
  const releases = await Promise.all(
    skillDirectories.flatMap(async (skillDirectory) => {
      const releaseRoot = path.join(skillsRoot, skillDirectory);
      const versions = await directoryNames(releaseRoot);
      return Promise.all(
        versions.map(async (version) => {
          const directory = path.join(releaseRoot, version);
          const skillBody = await readFile(path.join(directory, "SKILL.md"), "utf8");
          const metadataContents = await readFile(
            path.join(directory, "scient.skill.json"),
            "utf8",
          );
          const metadata: unknown = JSON.parse(metadataContents);
          assertBuiltInSkillMetadata(metadata);
          if (metadata.version !== version) {
            throw new Error(
              `${metadata.id} metadata version ${metadata.version} does not match directory ${version}.`,
            );
          }
          const frontmatter = parseSkillFrontmatter(skillBody);
          const assets = await collectReleaseAssets(directory);
          const expectedName = metadata.id.replace(/^scient\./, "scient-");
          if (frontmatter.name !== expectedName) {
            throw new Error(
              `${metadata.id} requires SKILL.md name ${expectedName}, received ${frontmatter.name}.`,
            );
          }
          return {
            ...metadata,
            name: frontmatter.name,
            description: frontmatter.description,
            origin: SCIENT_BUILT_IN_ORIGIN,
            digest: computeBuiltInSkillDigest([
              { path: "SKILL.md", contents: skillBody },
              { path: "scient.skill.json", contents: metadataContents },
              ...assets,
            ]),
            body: skillBody,
            assets,
          } satisfies BuiltInSkillRelease;
        }),
      );
    }),
  );
  const flattened = releases
    .flat()
    .toSorted((left, right) =>
      left.id === right.id
        ? compareBuiltInSkillVersions(left.version, right.version)
        : left.id.localeCompare(right.id),
    );
  const identities = new Set<string>();
  for (const release of flattened) {
    const identity = `${release.id}@${release.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate built-in skill release ${identity}.`);
    identities.add(identity);
  }
  return flattened;
}

export async function renderGeneratedCatalog(
  releases: readonly BuiltInSkillRelease[],
): Promise<string> {
  const source = [
    "// Generated by scripts/generate-catalog.ts. Do not edit directly.",
    'import type { BuiltInSkillRelease } from "./types.ts";',
    "",
    `export const GENERATED_BUILT_IN_SKILL_RELEASES = ${JSON.stringify(releases, null, 2)} as const satisfies readonly BuiltInSkillRelease[];`,
    "",
  ].join("\n");
  const result = await format(generatedPath, source);
  if (result.errors.length > 0) {
    throw new Error("Failed to format the generated built-in skill catalog.");
  }
  return result.code;
}

async function directoryNames(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

async function main(): Promise<void> {
  const expected = await renderGeneratedCatalog(await buildBuiltInSkillReleases());
  if (process.argv.includes("--check")) {
    const actual = await readFile(generatedPath, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error("Generated built-in skill catalog is stale. Run bun run generate.");
    }
    return;
  }
  await writeFile(generatedPath, expected, "utf8");
}

if (import.meta.main) await main();
