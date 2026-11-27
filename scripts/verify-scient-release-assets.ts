#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release verifier checks immutable artifact files before publication.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  assertScientReleaseChannelVersion,
  scientServerAssetName,
} from "@t3tools/shared/scientRelease";

import { assertBlockmapDescribesPayload } from "./lib/update-blockmap.ts";
import { parseUpdateManifest } from "./lib/update-manifest.ts";

interface ManifestDefinition {
  readonly name: string;
  readonly label: string;
  readonly requiredPayloads: ReadonlyArray<string>;
  /** Payloads electron-updater downloads differentially, so their `.blockmap` must ship. */
  readonly requiredBlockmaps: ReadonlyArray<string>;
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

function digest(path: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): string {
  const hash = NodeCrypto.createHash(algorithm);
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
  return hash.digest(encoding);
}

export function verifyScientReleaseAssets(args: ReadonlyArray<string>): {
  readonly version: string;
  readonly assets: ReadonlyArray<string>;
} {
  const assetsDir = NodePath.resolve(requiredValue(args, "--assets-dir"));
  const version = requiredValue(args, "--version").replace(/^v/u, "");
  const channel = args.includes("--channel") ? requiredValue(args, "--channel") : "stable";
  // What the native Windows verifier checked; a rebuilt package must not replace it unchecked.
  const windowsInstallerSha256 = requiredValue(args, "--windows-installer-sha256").toLowerCase();
  assertScientReleaseChannelVersion(version, channel);
  const manifestChannel = channel === "beta" ? "beta" : "latest";
  if (!NodeFS.statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Release assets directory does not exist: ${assetsDir}.`);
  }

  const definitions: ReadonlyArray<ManifestDefinition> = [
    {
      name: `${manifestChannel}-mac.yml`,
      label: "macOS",
      requiredPayloads: [
        `Scient-${version}-arm64.dmg`,
        `Scient-${version}-arm64.zip`,
        `Scient-${version}-x64.dmg`,
        `Scient-${version}-x64.zip`,
      ],
      requiredBlockmaps: [`Scient-${version}-arm64.zip`, `Scient-${version}-x64.zip`],
    },
    {
      name: `${manifestChannel}.yml`,
      label: "Windows",
      requiredPayloads: [`Scient-${version}-x64.exe`],
      requiredBlockmaps: [`Scient-${version}-x64.exe`],
    },
    {
      name: `${manifestChannel}-linux.yml`,
      label: "Linux",
      requiredPayloads: [`Scient-${version}-x86_64.AppImage`],
      // The AppImage carries its blockmap inside the file (manifest `blockMapSize`).
      requiredBlockmaps: [],
    },
  ];

  const allowed = new Set<string>();
  const payloads = new Set<string>();
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
      payloads.add(file.url);
      const payloadPath = NodePath.join(assetsDir, file.url);
      const stat = assertRegularNonemptyFile(payloadPath, `${definition.label} update payload`);
      if (stat.size !== file.size || digest(payloadPath, "sha512", "base64") !== file.sha512) {
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
    for (const required of definition.requiredBlockmaps) {
      assertRegularNonemptyFile(
        NodePath.join(assetsDir, `${required}.blockmap`),
        `${definition.label} update blockmap`,
      );
    }
  }

  const windowsInstaller = `Scient-${version}-x64.exe`;
  if (
    digest(NodePath.join(assetsDir, windowsInstaller), "sha256", "hex") !== windowsInstallerSha256
  ) {
    throw new Error(
      `${windowsInstaller} is not the installer the native Windows verifier checked (SHA-256 ${windowsInstallerSha256}).`,
    );
  }

  const serverName = scientServerAssetName(version);
  assertRegularNonemptyFile(NodePath.join(assetsDir, serverName), "remote server package");
  allowed.add(serverName);

  const actual = NodeFS.readdirSync(assetsDir).toSorted();
  for (const name of actual) {
    if (!name.endsWith(".blockmap")) continue;
    const payloadName = name.slice(0, -".blockmap".length);
    if (!payloads.has(payloadName)) {
      throw new Error(`Release assembly contains unattested blockmap: ${name}.`);
    }
    const blockmapPath = NodePath.join(assetsDir, name);
    assertRegularNonemptyFile(blockmapPath, "update blockmap");
    assertBlockmapDescribesPayload(blockmapPath, NodePath.join(assetsDir, payloadName));
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
