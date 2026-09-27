// @effect-diagnostics nodeBuiltinImport:off -- Test support: reads produced .docx packages and probes fake Pandoc processes.
/**
 * Shared fixtures for the Word export tests: document bundles, a tiny PNG, a
 * `.docx` reader, a scripted stand-in for Pandoc, and the managed-tool layer
 * the converter runs against.
 *
 * Tests that need the real Pandoc read its path from `SCIENT_PANDOC_BINARY`
 * and skip when it is unset or missing; nothing here downloads anything.
 */
import * as NodeFS from "node:fs";

import type { DocumentAsset, DocumentBundle, DocumentCitation } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as yauzl from "yauzl";

import { PandocManagedTool } from "./PandocManagedTool.ts";
import type { PandocCommand } from "./pandocProcess.ts";

/** A 2×2 red PNG. */
export const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A 3×1 blue PNG, distinct from {@link PNG_BYTES} (Word packages identical images once). */
export const PNG_BYTES_ALT = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAIAAACUgoPjAAAADUlEQVR4nGNgYPgPQQAL/gL+kc2Z/gAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export const SVG_BYTES = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#36c"/></svg>`,
);

export function bytesAsset(input: {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly fileName?: string;
  readonly mediaType?: string;
  readonly packagePath?: string;
  readonly role?: DocumentAsset["role"];
}): DocumentAsset {
  const fileName = input.fileName ?? `${input.id}.png`;
  return {
    id: input.id,
    role: input.role ?? "image",
    fileName,
    mediaType: input.mediaType ?? "image/png",
    byteLength: input.bytes.byteLength,
    packagePath: input.packagePath ?? `attachments/${fileName}`,
    content: { _tag: "bytes", bytes: input.bytes, sha256: `sha256:${"0".repeat(64)}` },
  };
}

export function makeBundle(input: {
  readonly markdown: string;
  readonly profile?: DocumentBundle["profile"];
  readonly assets?: ReadonlyArray<DocumentAsset>;
  readonly citations?: ReadonlyArray<DocumentCitation>;
  readonly direction?: DocumentBundle["metadata"]["direction"];
  readonly language?: string | null;
}): DocumentBundle {
  return {
    markdown: input.markdown,
    profile: input.profile ?? "document",
    metadata: {
      title: "Synthetic document",
      language: input.language ?? null,
      direction: input.direction ?? "auto",
      createdAt: null,
      source: {
        _tag: "conversation",
        threadId: ThreadId.make("thread-synthetic"),
        contentDigest: `sha256:${"a".repeat(64)}`,
        snapshotSequence: 1,
      },
    },
    assets: input.assets ?? [],
    citations: input.citations ?? [],
    warnings: [],
  };
}

/** Every entry of a `.docx` (or any ZIP) as bytes, by path. */
export function readZipEntries(filePath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("no zip"));
      const entries = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("no stream"));
          const chunks: Array<Buffer> = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

export const readDocx = (filePath: string) =>
  Effect.promise(() => readZipEntries(filePath)).pipe(
    Effect.map((entries) => ({
      entries,
      text: (name: string) => entries.get(name)?.toString("utf8") ?? "",
      /** Every part as text, for searching secrets and injected markup. */
      allText: () => [...entries.values()].map((bytes) => bytes.toString("latin1")).join("\n"),
    })),
  );

export const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** The real managed binary for local integration tests, or null to skip them. */
export function pandocBinaryForTests(): string | null {
  const candidate = process.env.SCIENT_PANDOC_BINARY?.trim();
  return candidate && NodeFS.existsSync(candidate) ? candidate : null;
}

/** A managed tool that reports `command` as installed and keeps scratch under `scratchRoot`. */
export function managedToolLayer(input: {
  readonly command: PandocCommand | null;
  readonly scratchRoot: string;
}) {
  return Layer.succeed(
    PandocManagedTool,
    PandocManagedTool.of({
      canInstall: true,
      install: Effect.die("not used"),
      status: Effect.succeed({
        version: "3.11",
        installed: input.command !== null,
        canInstall: true,
        unavailableReason: null,
        downloadBytes: 41_832_712,
        install: {
          state: "idle",
          bytesReceived: null,
          totalBytes: null,
          failureReason: null,
          updatedAtEpochMs: 0,
        },
      }),
      command: Effect.succeed(input.command),
      scratchRoot: input.scratchRoot,
    }),
  );
}

/**
 * A stand-in for Pandoc run as `node -e <source> -- <args>`. Behaviour comes
 * from the first argument after `--`: `echo` copies stdin to stdout, `env`
 * prints its environment and arguments as JSON, `sleep` records its pid and
 * waits, `flood` writes without end, `exit:<code>` prints to stderr and exits.
 */
export function fakePandoc(pidFile: string): (mode: string) => PandocCommand {
  const source = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "const [mode, ...rest] = process.argv.slice(1);",
    "if (mode === 'echo') { process.stdin.pipe(process.stdout); }",
    "else if (mode === 'env') { process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ env: process.env, args: rest, cwd: process.cwd() }))); }",
    "else if (mode === 'sleep') { setInterval(() => {}, 1000); }",
    "else if (mode === 'flood') { const chunk = Buffer.alloc(65536, 120); const pump = () => { while (process.stdout.write(chunk)) {} process.stdout.once('drain', pump); }; pump(); }",
    "else if (mode.startsWith('exit:')) { process.stderr.write('[WARNING] something odd\\n  continued\\npandoc: failure detail\\n'); process.exit(Number(mode.slice(5))); }",
  ].join("\n");
  return (mode) => ({ command: process.execPath, leadingArgs: ["-e", source, "--", mode] });
}

export function readPid(pidFile: string): number | null {
  try {
    return Number.parseInt(NodeFS.readFileSync(pidFile, "utf8"), 10);
  } catch {
    return null;
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
