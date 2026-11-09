#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalConsole:off -- A CI check of Scient's own release copies: plain HTTPS requests, hashing and short waits between tries, outside any Effect runtime.
/**
 * Checks Scient's own copies of a provider's catalog release. The default
 * check asks for each file's size; `--full` downloads every file and compares
 * its digest with the catalog, which gates publication.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { resolveScientAgentArtifactPolicy } from "@scientfactory/provider-runtime";

import { readManagedRuntimeCatalog } from "./lib/managed-runtime-catalog.ts";

/** Families with a Scient-hosted copy, and where it lives. */
const MIRROR_URL_PREFIXES: Readonly<Record<string, string | undefined>> = {
  scient: resolveScientAgentArtifactPolicy({ platform: "darwin", arch: "arm64" })?.mirrorUrlPrefix,
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** A blip shouldn't turn the run red; three tries, five seconds apart. */
async function withTries<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (cause) {
      if (attempt === 3) throw cause;
      await NodeTimersPromises.setTimeout(5_000);
    }
  }
}

async function checkSize(url: string, size: number): Promise<string | null> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  return length === size ? null : `size ${length}, catalog says ${size}`;
}

async function checkDigest(
  url: string,
  size: number,
  checksum: { readonly algorithm: "sha256" | "sha512"; readonly digest: string },
): Promise<string | null> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const hash = NodeCrypto.createHash(checksum.algorithm);
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  if (bytes !== size) return `size ${bytes}, catalog says ${size}`;
  const digest = hash.digest("hex");
  return digest === checksum.digest.toLowerCase()
    ? null
    : `${checksum.algorithm} ${digest}, catalog says ${checksum.digest}`;
}

const provider = argument("--provider");
const catalogPath = argument("--catalog");
const full = process.argv.includes("--full");
if (!provider || !catalogPath) throw new Error("--provider and --catalog are required.");

const prefix = MIRROR_URL_PREFIXES[provider];
const catalog = readManagedRuntimeCatalog(
  JSON.parse(await NodeFSP.readFile(NodePath.resolve(catalogPath), "utf8")),
);
const release = catalog.providers[provider as keyof typeof catalog.providers];
if (!prefix || !release) {
  console.log(`${provider}: no Scient-hosted copy to check.`);
} else {
  const problems: string[] = [];
  for (const artifact of Object.values(release.artifacts)) {
    const url = `${prefix}${release.version}/${artifact.artifactName}`;
    const problem = await withTries(() =>
      full ? checkDigest(url, artifact.size, artifact.checksum) : checkSize(url, artifact.size),
    ).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    console.log(`${problem ? "FAIL" : "ok  "} ${url}${problem ? `: ${problem}` : ""}`);
    if (problem) problems.push(url);
  }
  if (problems.length > 0) {
    console.error(
      `${problems.length} of Scient's copies of ${provider} ${release.version} are missing or differ from the catalog.`,
    );
    process.exit(1);
  }
  console.log(
    `${provider} ${release.version}: all ${Object.keys(release.artifacts).length} copies ${full ? "match the catalog digest" : "are present at the catalog size"}.`,
  );
}
