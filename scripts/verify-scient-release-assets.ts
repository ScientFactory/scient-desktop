#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release verifier checks immutable artifact files before publication.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isExactScientReleaseVersion, scientServerAssetName } from "@t3tools/shared/scientRelease";

import { parseUpdateManifest } from "./lib/update-manifest.ts";

interface ManifestDefinition {
  readonly name: string;
  readonly label: string;
  readonly requiredPayloads: ReadonlyArray<string>;
}

function requiredValue(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

function assertRegularNonemptyFile(path: string, label: string): NodeFS.Stats {
  const stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Missing ${label}: ${NodePath.basename(path)}.`);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file: ${NodePath.basename(path)}.`);
  }
  return stat;
}

function sha512(path: string): string {
  const hash = NodeCrypto.createHash("sha512");
  const file = NodeFS.openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = NodeFS.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    NodeFS.closeSync(file);
  }
  return hash.digest("base64");
}

export function verifyScientReleaseAssets(args: ReadonlyArray<string>): {
  readonly version: string;
  readonly assets: ReadonlyArray<string>;
} {
  const assetsDir = NodePath.resolve(requiredValue(args, "--assets-dir"));
  const version = requiredValue(args, "--version").replace(/^v/u, "");
  if (!isExactScientReleaseVersion(version) || version.includes("-")) {
    throw new Error(`Stable releases require a canonical x.y.z version, received '${version}'.`);
  }
  if (!NodeFS.statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Release assets directory does not exist: ${assetsDir}.`);
  }

  const definitions: ReadonlyArray<ManifestDefinition> = [
    {
      name: "latest-mac.yml",
      label: "macOS",
      requiredPayloads: [
        `Scient-${version}-arm64.dmg`,
        `Scient-${version}-arm64.zip`,
        `Scient-${version}-x64.dmg`,
        `Scient-${version}-x64.zip`,
      ],
    },
    {
      name: "latest.yml",
      label: "Windows",
      requiredPayloads: [`Scient-${version}-x64.exe`],
    },
    {
      name: "latest-linux.yml",
      label: "Linux",
      requiredPayloads: [`Scient-${version}-x86_64.AppImage`],
    },
  ];

  const allowed = new Set<string>();
  for (const definition of definitions) {
    const manifestPath = NodePath.join(assetsDir, definition.name);
    assertRegularNonemptyFile(manifestPath, `${definition.label} update manifest`);
    allowed.add(definition.name);
    const manifest = parseUpdateManifest(
      NodeFS.readFileSync(manifestPath, "utf8"),
      manifestPath,
      definition.label,
    );
    if (manifest.version !== version) {
      throw new Error(
        `${definition.label} update manifest has version ${manifest.version}; expected ${version}.`,
      );
    }

    const urls = new Set<string>();
    for (const file of manifest.files) {
      if (!file.url || NodePath.basename(file.url) !== file.url || urls.has(file.url)) {
        throw new Error(`${definition.label} update manifest has an unsafe or duplicate file URL.`);
      }
      urls.add(file.url);
      allowed.add(file.url);
      const payloadPath = NodePath.join(assetsDir, file.url);
      const stat = assertRegularNonemptyFile(payloadPath, `${definition.label} update payload`);
      if (stat.size !== file.size || sha512(payloadPath) !== file.sha512) {
        throw new Error(
          `${definition.label} update payload failed size or SHA-512 verification: ${file.url}.`,
        );
      }
    }
    for (const required of definition.requiredPayloads) {
      if (!urls.has(required)) {
        throw new Error(
          `${definition.label} update manifest does not reference required ${required}.`,
        );
      }
    }
  }

  const serverName = scientServerAssetName(version);
  assertRegularNonemptyFile(NodePath.join(assetsDir, serverName), "remote server package");
  allowed.add(serverName);

  const actual = NodeFS.readdirSync(assetsDir).toSorted();
  for (const name of actual) {
    if (!name.endsWith(".blockmap")) continue;
    const payloadName = name.slice(0, -".blockmap".length);
    if (!allowed.has(payloadName)) {
      throw new Error(`Release assembly contains unattested blockmap: ${name}.`);
    }
    assertRegularNonemptyFile(NodePath.join(assetsDir, name), "update blockmap");
    allowed.add(name);
  }
  const unexpected = actual.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `Release assembly contains unexpected or unattested files: ${unexpected.join(", ")}.`,
    );
  }
  const missing = [...allowed].filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(`Release assembly is missing required files: ${missing.join(", ")}.`);
  }

  return { version, assets: actual };
}

const isMain = process.argv[1]
  ? NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(verifyScientReleaseAssets(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
