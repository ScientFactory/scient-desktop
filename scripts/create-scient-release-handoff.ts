#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone release attestation tool runs before an Effect application runtime exists.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface ReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

function value(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  const result = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!result) throw new Error(`${flag} is required.`);
  return result;
}

function sha256(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

export function createScientReleaseHandoff(args: ReadonlyArray<string>): string {
  const assetsDir = NodePath.resolve(value(args, "--assets-dir"));
  const version = value(args, "--version").replace(/^v/u, "");
  const sourceSha = value(args, "--source-sha");
  const sourceTree = value(args, "--source-tree");
  const output = NodePath.resolve(value(args, "--output"));
  const excluded = new Set([NodePath.basename(output), "SHA256SUMS.txt"]);
  const assets: ReleaseAsset[] = NodeFS.readdirSync(assetsDir)
    .filter((name) => !excluded.has(name))
    .map((name) => {
      const path = NodePath.join(assetsDir, name);
      const stat = NodeFS.statSync(path);
      if (!stat.isFile()) throw new Error(`Release asset '${name}' is not a file.`);
      return { name, size: stat.size, sha256: sha256(path) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (assets.length === 0) throw new Error("No release assets were found.");

  NodeFS.writeFileSync(
    NodePath.join(assetsDir, "SHA256SUMS.txt"),
    `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
  );
  NodeFS.writeFileSync(
    output,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "Scient",
        version,
        tag: `v${version}`,
        source: {
          repository: "ScientFactory/scient-desktop-next",
          commit: sourceSha,
          tree: sourceTree,
        },
        assets,
      },
      null,
      2,
    )}\n`,
  );
  return output;
}

const isMain = process.argv[1]
  ? NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  try {
    process.stdout.write(`${createScientReleaseHandoff(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
