#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalConsole:off -- A CI check of Scient's own release copies: plain HTTPS requests, hashing and short waits between tries, outside any Effect runtime.
/**
 * Checks Scient's own copies of a provider's catalog release, the binaries and
 * their compressed copies. The default check asks for each file's size; `--full`
 * downloads every file and compares its digest with the catalog, and unpacks each
 * compressed copy to the binary's digest, which gates publication.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeZlib from "node:zlib";

import {
  resolveScientAgentArtifactPolicy,
  SCIENT_AGENT_TARGETS,
} from "@scientfactory/provider-runtime";

import { readManagedRuntimeCatalog } from "./lib/managed-runtime-catalog.ts";

/** Families with a Scient-hosted copy, and where it lives. */
const MIRROR_URL_PREFIXES: Readonly<Record<string, string | undefined>> = {
  scient: resolveScientAgentArtifactPolicy({ platform: "darwin", arch: "arm64" })?.mirrorUrlPrefix,
};

/** The compressed copy's file name for a binary, as the app's policy names it. */
function compressedArtifactName(artifactName: string): string | undefined {
  return SCIENT_AGENT_TARGETS.map(resolveScientAgentArtifactPolicy).find(
    (policy) => policy?.artifactName === artifactName,
  )?.compressedArtifactName;
}

type Checksum = { readonly algorithm: "sha256" | "sha512"; readonly digest: string };

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

/** Hashes what passes through, counting its bytes; a mismatch is described, a match is null. */
function digestCheck(checksum: Checksum, size: number) {
  const hash = NodeCrypto.createHash(checksum.algorithm);
  let bytes = 0;
  return {
    stream: new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    result: (label: string): string | null => {
      if (bytes !== size) return `${label} size ${bytes}, catalog says ${size}`;
      const digest = hash.digest("hex");
      return digest === checksum.digest.toLowerCase()
        ? null
        : `${label} ${checksum.algorithm} ${digest}, catalog says ${checksum.digest}`;
    },
  };
}

/** With `unpacked`, the file is a zstd copy that must also unpack to those bytes. */
async function checkDigest(
  url: string,
  size: number,
  checksum: Checksum,
  unpacked?: { readonly size: number; readonly checksum: Checksum },
): Promise<string | null> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const file = digestCheck(checksum, size);
  const binary = unpacked ? digestCheck(unpacked.checksum, unpacked.size) : undefined;
  await NodeStreamPromises.pipeline([
    NodeStream.Readable.fromWeb(response.body as never),
    file.stream,
    // The window the app allows: a copy that needs more would not install.
    ...(binary
      ? [
          NodeZlib.createZstdDecompress({
            params: { [NodeZlib.constants.ZSTD_d_windowLogMax]: 27 },
          }),
          binary.stream,
        ]
      : []),
    new NodeStream.Writable({ write: (_chunk, _encoding, callback) => callback() }),
  ]);
  return file.result("file") ?? binary?.result("unpacked") ?? null;
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
  let files = 0;
  for (const artifact of Object.values(release.artifacts)) {
    const compressedName =
      artifact.compressed?.format === "zstd"
        ? compressedArtifactName(artifact.artifactName)
        : undefined;
    const copies = [
      { name: artifact.artifactName, size: artifact.size, checksum: artifact.checksum },
      ...(artifact.compressed && compressedName
        ? [{ name: compressedName, ...artifact.compressed, unpacked: artifact }]
        : []),
    ];
    for (const copy of copies) {
      files += 1;
      const url = `${prefix}${release.version}/${copy.name}`;
      const problem = await withTries(() =>
        full
          ? checkDigest(
              url,
              copy.size,
              copy.checksum,
              "unpacked" in copy ? copy.unpacked : undefined,
            )
          : checkSize(url, copy.size),
      ).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
      console.log(`${problem ? "FAIL" : "ok  "} ${url}${problem ? `: ${problem}` : ""}`);
      if (problem) problems.push(url);
    }
  }
  if (problems.length > 0) {
    console.error(
      `${problems.length} of Scient's copies of ${provider} ${release.version} are missing or differ from the catalog.`,
    );
    process.exit(1);
  }
  console.log(
    `${provider} ${release.version}: all ${files} copies ${full ? "match the catalog digest" : "are present at the catalog size"}.`,
  );
}
