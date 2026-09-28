// @effect-diagnostics nodeBuiltinImport:off -- fixtures are ZIP files built and patched on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  ConversationImportRejection,
  SCIC_MEDIA_TYPE,
  type ConversationImportId,
  type ConversationImportRejectionReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as yazl from "yazl";

import { conversationContentDigest } from "../conversationImport/ConversationImporter.ts";
import {
  inspectScicExpandedBytes,
  readScicPackage,
  reportedEntryName,
  stagedAttachmentFile,
} from "./ScicReader.ts";
import {
  PDF,
  PNG,
  STATE_ROOT,
  attachment,
  capturedSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  makePackage,
  zipBytesPromise,
  type ZipFileSpec,
} from "./scic.test-fixtures.ts";
import { sha256Digest, type ScicPackage } from "./ScicWriter.ts";
import {
  SCIC_MANIFEST_ENTRY,
  SCIC_MARKDOWN_ENTRY,
  SCIC_MAX_ENTRIES,
  SCIC_MIMETYPE_ENTRY,
  SCIC_SNAPSHOT_ENTRY,
  scicAttachmentPath,
  type ScicManifest,
} from "./scicFormat.ts";

const IMPORT_ID = "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b" as ConversationImportId;
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

/** Rebuilds a package's files from its parts, recomputing the manifest's entry list. */
function assemble(input: {
  readonly snapshot: unknown;
  readonly manifest: ScicManifest;
  readonly markdown?: Uint8Array;
  readonly attachments: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
  readonly mediaTypes?: ReadonlyMap<string, string>;
}): ReadonlyArray<ZipFileSpec> {
  const snapshotBytes = json(input.snapshot);
  const markdown = input.markdown ?? encoder.encode("# Conversation\n");
  const manifest: ScicManifest = {
    ...input.manifest,
    entries: [
      {
        path: SCIC_SNAPSHOT_ENTRY,
        mediaType: "application/json",
        byteLength: snapshotBytes.byteLength,
        sha256: sha256Digest(snapshotBytes),
      },
      {
        path: SCIC_MARKDOWN_ENTRY,
        mediaType: "text/markdown; charset=utf-8",
        byteLength: markdown.byteLength,
        sha256: sha256Digest(markdown),
      },
      ...input.attachments.map((file) => ({
        path: file.path,
        mediaType:
          input.mediaTypes?.get(file.path) ??
          input.manifest.entries.find((entry) => entry.path === file.path)?.mediaType ??
          "application/octet-stream",
        byteLength: file.bytes.byteLength,
        sha256: sha256Digest(file.bytes),
      })),
    ],
  };
  return [
    { path: SCIC_MIMETYPE_ENTRY, bytes: encoder.encode(SCIC_MEDIA_TYPE), compress: false },
    { path: SCIC_MANIFEST_ENTRY, bytes: json(manifest) },
    { path: SCIC_SNAPSHOT_ENTRY, bytes: snapshotBytes },
    { path: SCIC_MARKDOWN_ENTRY, bytes: markdown },
    ...input.attachments.map((file) => ({ ...file, compress: false })),
  ];
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-scic-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;

/** Calls `patch` with the offset of every central-directory (and local) header naming `name`. */
function patchHeaders(
  buffer: Buffer,
  name: string,
  patch: (offset: number, kind: "central" | "local") => void,
): Buffer {
  const target = Buffer.from(name);
  for (let offset = 0; offset < buffer.length - 46; offset += 1) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === SIGNATURE_CENTRAL) {
      const length = buffer.readUInt16LE(offset + 28);
      if (buffer.subarray(offset + 46, offset + 46 + length).equals(target)) {
        patch(offset, "central");
      }
    } else if (signature === SIGNATURE_LOCAL) {
      const length = buffer.readUInt16LE(offset + 26);
      if (buffer.subarray(offset + 30, offset + 30 + length).equals(target)) patch(offset, "local");
    }
  }
  return buffer;
}

function replaceAll(buffer: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const source = Buffer.from(from);
  let index = buffer.indexOf(source);
  while (index >= 0) {
    Buffer.from(to).copy(buffer, index);
    index = buffer.indexOf(source, index + 1);
  }
  return buffer;
}

const zipBytes = (files: ReadonlyArray<ZipFileSpec>) =>
  Effect.promise(() => zipBytesPromise(files));

const read = Effect.fnUntraced(function* (bytes: Uint8Array, directory = temporaryDirectory()) {
  const packagePath = NodePath.join(directory, "package.scic");
  NodeFS.writeFileSync(packagePath, bytes);
  const attachmentsDirectory = NodePath.join(directory, "attachments");
  NodeFS.mkdirSync(attachmentsDirectory);
  const exit = yield* Effect.exit(
    readScicPackage({
      importId: IMPORT_ID,
      packagePath,
      packageSha256: sha256Digest(bytes),
      packageBytes: bytes.byteLength,
      attachmentsDirectory,
    }),
  );
  return { exit, attachmentsDirectory };
});

const expectRejected = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  reason: ConversationImportRejectionReason,
  entry?: string | null,
) {
  const { exit } = yield* read(bytes);
  if (Exit.isSuccess(exit)) throw new Error(`Expected ${reason}, but the package validated.`);
  const error = exit.cause.reasons.find((cause) => cause._tag === "Fail")?.error;
  expect(error?._tag).toBe("ScicRejection");
  expect(error?._tag === "ScicRejection" ? error.reason : null).toBe(reason);
  if (entry !== undefined) expect(error?._tag === "ScicRejection" ? error.entry : null).toBe(entry);
});

// What a client decodes: a trimmed, non-empty name of at most 512 units, or null.
const decodeRejection = Schema.decodeExit(ConversationImportRejection);

const packageZip = (pkg = makePackage()) => zipBytes(pkg.files);

it.effect("reports a staged-file write error without an unhandled stream error", () =>
  Effect.gen(function* () {
    const bytes = yield* packageZip();
    const directory = temporaryDirectory();
    const packagePath = NodePath.join(directory, "package.scic");
    const attachmentsDirectory = NodePath.join(directory, "blocked");
    NodeFS.writeFileSync(packagePath, bytes);
    NodeFS.writeFileSync(attachmentsDirectory, "not a directory");
    const error = yield* Effect.flip(
      readScicPackage({
        importId: IMPORT_ID,
        packagePath,
        packageSha256: sha256Digest(bytes),
        packageBytes: bytes.byteLength,
        attachmentsDirectory,
      }),
    );
    expect(error._tag).toBe("ScicReadError");
  }),
);

it.effect("refuses expansion beyond the admitted central-directory size", () =>
  Effect.gen(function* () {
    const bytes = yield* packageZip();
    const directory = temporaryDirectory();
    const packagePath = NodePath.join(directory, "package.scic");
    const attachmentsDirectory = NodePath.join(directory, "attachments");
    NodeFS.writeFileSync(packagePath, bytes);
    NodeFS.mkdirSync(attachmentsDirectory);
    const expanded = yield* inspectScicExpandedBytes(packagePath);
    expect(expanded).toBeGreaterThan(1);
    const error = yield* Effect.flip(
      readScicPackage({
        importId: IMPORT_ID,
        packagePath,
        packageSha256: sha256Digest(bytes),
        packageBytes: bytes.byteLength,
        attachmentsDirectory,
        maxExpandedBytes: expanded - 1,
      }),
    );
    expect(error._tag).toBe("ScicRejection");
    if (error._tag === "ScicRejection") expect(error.reason).toBe("package-too-large");
    expect(NodeFS.readdirSync(attachmentsDirectory)).toEqual([]);
  }),
);

function pdfPath(pkg: ScicPackage) {
  const resource = pkg.manifest.resources.find(
    (entry) => entry._tag === "included" && entry.kind === "file",
  );
  if (resource?._tag !== "included") throw new Error("The fixture has no included file.");
  return resource;
}

describe("the .scic writer", () => {
  it("makes the snapshot portable and restates attachment facts", () => {
    const pkg = makePackage();
    const [first] = pkg.snapshot.messages;
    expect(first!.attachments.map((item) => [item.localId, item.available])).toEqual([
      ["attachment-1", true],
      ["attachment-2", true],
      ["attachment-3", false],
    ]);
    expect(first!.references[0]).toMatchObject({ attachmentLocalId: "attachment-1" });
    expect(first!.text).not.toContain(STATE_ROOT);
    expect(pkg.snapshot.contentDigest).toBe(conversationContentDigest(pkg.snapshot));
    expect(pkg.snapshot.contentDigest).not.toBe(capturedSnapshot.contentDigest);
    const serialized = new TextDecoder().decode(
      Buffer.concat(pkg.files.map((file) => Buffer.from(file.bytes))),
    );
    expect(serialized).not.toContain("thread-1-aaaa");
    expect(serialized).not.toContain(STATE_ROOT);
  });

  it.effect("writes mimetype first and stored, and every other entry into the manifest", () =>
    Effect.gen(function* () {
      const pkg = makePackage();
      expect(pkg.files[0]).toMatchObject({ path: SCIC_MIMETYPE_ENTRY, compress: false });
      const bytes = yield* zipBytes(pkg.files);
      // The media type is readable from the first bytes of the file.
      expect(bytes.subarray(30, 38).toString()).toBe(SCIC_MIMETYPE_ENTRY);
      expect(bytes.includes(Buffer.from(SCIC_MEDIA_TYPE))).toBe(true);
      expect(pkg.manifest.entries.map((entry) => entry.path).toSorted()).toEqual(
        pkg.files
          .map((file) => file.path)
          .filter((path) => path !== SCIC_MIMETYPE_ENTRY && path !== SCIC_MANIFEST_ENTRY)
          .toSorted(),
      );
    }),
  );

  it("carries attachments outside the media policy as unavailable", () => {
    const svg = encoder.encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const snapshot = decodeSnapshot({
      ...encodeSnapshot(capturedSnapshot),
      messages: capturedSnapshot.messages.map((message) =>
        message.n === 1
          ? {
              ...message,
              attachments: [
                attachment("thread-1-aaaa", "image", "figure.svg", "image/svg+xml", svg.byteLength),
                attachment("thread-1-bbbb", "file", "paper.pdf", "application/pdf", 4),
              ],
              references: [],
            }
          : message,
      ),
      warnings: [],
    });
    const pkg = makePackage(
      snapshot,
      new Map([
        ["thread-1-aaaa", { _tag: "bytes" as const, bytes: svg, sha256: sha256Digest(svg) }],
        // Declared a PDF, but the bytes say otherwise.
        ["thread-1-bbbb", { _tag: "bytes" as const, bytes: PNG, sha256: sha256Digest(PNG) }],
      ]),
    );
    expect(pkg.manifest.resources.map((resource) => resource._tag)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    expect(pkg.snapshot.warnings).toHaveLength(2);
    expect(pkg.warnings.map((warning) => warning.message).join("\n")).toContain(
      "is not a type or size Scient can import",
    );
  });

  it.effect("stores a highly compressible valid attachment so its own reader accepts it", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(2 * 1024 * 1024).fill(65);
      const snapshot = decodeSnapshot({
        ...encodeSnapshot(capturedSnapshot),
        messages: capturedSnapshot.messages.map((message) =>
          message.n === 1
            ? {
                ...message,
                attachments: [
                  attachment(
                    "thread-1-text",
                    "file",
                    "repeated.txt",
                    "text/plain",
                    bytes.byteLength,
                  ),
                ],
                references: [],
              }
            : message,
        ),
        warnings: [],
      });
      const pkg = makePackage(
        snapshot,
        new Map([
          ["thread-1-text", { _tag: "bytes" as const, bytes, sha256: sha256Digest(bytes) }],
        ]),
      );
      const resource = pkg.manifest.resources.find((entry) => entry.name === "repeated.txt");
      if (resource?._tag !== "included") throw new Error("The text attachment was not included.");
      yield* expectRejected(
        yield* zipBytes(
          pkg.files.map((file) =>
            file.path === resource.path ? { ...file, compress: true } : file,
          ),
        ),
        "compression-ratio",
        resource.path,
      );
      expect(pkg.files.find((file) => file.path === resource.path)?.compress).toBe(false);
      const { exit, attachmentsDirectory } = yield* read(yield* zipBytes(pkg.files));
      if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
      expect(exit.value.attachments).toHaveLength(1);
      expect(
        new Uint8Array(
          NodeFS.readFileSync(stagedAttachmentFile(attachmentsDirectory, resource.sha256)),
        ),
      ).toEqual(bytes);
    }),
  );
});

describe("the .scic reader", () => {
  it.effect("round-trips a package to an equal snapshot and byte-identical attachments", () =>
    Effect.gen(function* () {
      const pkg = makePackage();
      const { exit, attachmentsDirectory } = yield* read(yield* zipBytes(pkg.files));
      if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
      const validated = exit.value;
      expect(encodeSnapshot(validated.snapshot)).toEqual(encodeSnapshot(pkg.snapshot));
      expect(validated.package).toMatchObject({
        exportId: "7f3c9a2e41b8",
        sourceThreadId: "thread-1",
        contentDigest: pkg.contentDigest,
      });
      expect(validated.attachments.map((staged) => staged.resourceId)).toEqual([
        "attachment-1",
        "attachment-2",
      ]);
      for (const [staged, original] of [
        [validated.attachments[0]!, PNG],
        [validated.attachments[1]!, PDF],
      ] as const) {
        expect(
          new Uint8Array(
            NodeFS.readFileSync(stagedAttachmentFile(attachmentsDirectory, staged.sha256)),
          ),
        ).toEqual(original);
      }
      expect(validated.omissions).toContainEqual({
        _tag: "snapshot-warning",
        warning: { _tag: "attachment-unavailable", name: "gone.csv", messageN: 1 },
      });
    }),
  );

  it.effect("validates a file exported on one state root on another", () =>
    Effect.gen(function* () {
      const exported = NodePath.join(temporaryDirectory(), "Export design.scic");
      NodeFS.writeFileSync(exported, yield* packageZip());
      const elsewhere = temporaryDirectory();
      const { exit } = yield* read(NodeFS.readFileSync(exported), elsewhere);
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  describe("rejects", () => {
    it.effect("a file that is not a ZIP", () =>
      Effect.gen(function* () {
        yield* expectRejected(encoder.encode("not a zip at all"), "corrupt-archive");
      }),
    );

    it.effect("a missing, wrong, compressed, or misplaced mimetype", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const [mimetype, ...rest] = pkg.files;
        yield* expectRejected(yield* zipBytes(rest), "mimetype-invalid");
        yield* expectRejected(
          yield* zipBytes([
            { ...mimetype!, bytes: encoder.encode("application/zip!!!!!!!!!!!!!!!!!!!!!!!") },
            ...rest,
          ]),
          "mimetype-invalid",
        );
        yield* expectRejected(
          yield* zipBytes([
            { ...mimetype!, bytes: encoder.encode("application/vnd.scient.conversation+zap") },
            ...rest,
          ]),
          "mimetype-invalid",
        );
        yield* expectRejected(
          yield* zipBytes([{ ...mimetype!, compress: true }, ...rest]),
          "mimetype-invalid",
        );
        yield* expectRejected(
          yield* zipBytes([rest[0]!, mimetype!, ...rest.slice(1)]),
          "mimetype-invalid",
        );
      }),
    );

    it.effect("absolute, drive, backslashed, and parent-traversing paths", () =>
      Effect.gen(function* () {
        for (const [placeholder, unsafe] of [
          ["zz/evil.txt", "/z/evil.txt"],
          ["zzevil.txt", "C:evil.txt"],
          ["zz_evil.txt", "zz\\evil.txt"],
          ["zz/evil.txt", "../evil.txt"],
          ["aa/zz/evil", "aa/../evil"],
        ] as const) {
          const bytes = yield* zipBytes([
            ...makePackage().files,
            { path: placeholder, bytes: PNG },
          ]);
          yield* expectRejected(replaceAll(bytes, placeholder, unsafe), "unsafe-path");
        }
      }),
    );

    it.effect("symlinks, folders, and other special files", () =>
      Effect.gen(function* () {
        yield* expectRejected(
          yield* zipBytes([...makePackage().files, { path: "link", bytes: PNG, mode: 0o120777 }]),
          "special-entry",
          "link",
        );
        yield* expectRejected(
          yield* zipBytes([...makePackage().files, { path: "fifo", bytes: PNG, mode: 0o010644 }]),
          "special-entry",
          "fifo",
        );
        const withFolder = yield* Effect.promise(
          () =>
            new Promise<Buffer>((resolve, reject) => {
              const zip = new yazl.ZipFile();
              const chunks: Buffer[] = [];
              zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
              zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
              zip.outputStream.on("error", reject);
              for (const file of makePackage().files) {
                zip.addBuffer(Buffer.from(file.bytes), file.path, { compress: file.compress });
              }
              zip.addEmptyDirectory("folder");
              zip.end();
            }),
        );
        yield* expectRejected(withFolder, "unsafe-path");
      }),
    );

    it.effect("duplicate and case-colliding paths", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const pdf = pkg.files.find((file) => file.path === pdfPath(pkg).path)!;
        yield* expectRejected(yield* zipBytes([...pkg.files, pdf]), "duplicate-path", pdf.path);
        yield* expectRejected(
          yield* zipBytes([...pkg.files, { ...pdf, path: "CONVERSATION.md" }]),
          "duplicate-path",
          "CONVERSATION.md",
        );
      }),
    );

    it.effect("encrypted entries", () =>
      Effect.gen(function* () {
        const bytes = yield* packageZip();
        yield* expectRejected(
          patchHeaders(bytes, SCIC_MARKDOWN_ENTRY, (offset, kind) => {
            const flagOffset = offset + (kind === "central" ? 8 : 6);
            bytes.writeUInt16LE(bytes.readUInt16LE(flagOffset) | 1, flagOffset);
          }),
          "encrypted-entry",
          SCIC_MARKDOWN_ENTRY,
        );
      }),
    );

    it.effect("too many entries", () =>
      Effect.gen(function* () {
        // A ZIP64 or forged directory count must be rejected before listing
        // entry objects. This tiny archive advertises more than the limit.
        const advertised = Buffer.from(yield* packageZip());
        const eocd = advertised.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        expect(eocd).toBeGreaterThanOrEqual(0);
        advertised.writeUInt16LE(SCIC_MAX_ENTRIES + 1, eocd + 8);
        advertised.writeUInt16LE(SCIC_MAX_ENTRIES + 1, eocd + 10);
        yield* expectRejected(advertised, "too-many-entries");

        const extra = Array.from({ length: SCIC_MAX_ENTRIES }, (_, index) => ({
          path: `extra/${index}`,
          bytes: new Uint8Array(0),
          compress: false,
        }));
        yield* expectRejected(
          yield* zipBytes([...makePackage().files, ...extra]),
          "too-many-entries",
        );
      }),
    );

    it.effect("oversized entries, excessive total size, and excessive compression ratio", () =>
      Effect.gen(function* () {
        const setUncompressed = (bytes: Buffer, name: string, size: number) =>
          patchHeaders(bytes, name, (offset, kind) => {
            if (kind === "central") bytes.writeUInt32LE(size, offset + 24);
          });
        yield* expectRejected(
          setUncompressed(yield* packageZip(), SCIC_MARKDOWN_ENTRY, 65 * 1024 * 1024),
          "entry-too-large",
          SCIC_MARKDOWN_ENTRY,
        );
        const bulky = Array.from({ length: 12 }, (_, index) => ({
          path: `attachments/bulk-${index}`,
          bytes: PNG,
        }));
        let bytes = yield* zipBytes([...makePackage().files, ...bulky]);
        for (const file of bulky) bytes = setUncompressed(bytes, file.path, 50 * 1024 * 1024);
        bytes = setUncompressed(bytes, SCIC_SNAPSHOT_ENTRY, 128 * 1024 * 1024);
        yield* expectRejected(bytes, "package-too-large");
        yield* expectRejected(
          setUncompressed(yield* packageZip(), SCIC_MARKDOWN_ENTRY, 4 * 1024 * 1024),
          "compression-ratio",
          SCIC_MARKDOWN_ENTRY,
        );
      }),
    );

    it.effect("size and hash mismatches against the manifest", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const base = {
          snapshot: encodeSnapshot(pkg.snapshot),
          manifest: pkg.manifest,
          attachments: pkg.files.filter((file) => file.path.startsWith("attachments/")),
        };
        const withManifest = (
          files: ReadonlyArray<ZipFileSpec>,
          change: (m: ScicManifest) => ScicManifest,
        ) =>
          files.map((file) =>
            file.path === SCIC_MANIFEST_ENTRY
              ? { ...file, bytes: json(change(JSON.parse(new TextDecoder().decode(file.bytes)))) }
              : file,
          );
        const files = assemble(base);
        yield* expectRejected(
          yield* zipBytes(
            withManifest(files, (manifest) => ({
              ...manifest,
              entries: manifest.entries.map((entry) =>
                entry.path === SCIC_MARKDOWN_ENTRY
                  ? { ...entry, sha256: `sha256:${"f".repeat(64)}` }
                  : entry,
              ),
            })),
          ),
          "manifest-mismatch",
          SCIC_MARKDOWN_ENTRY,
        );
        yield* expectRejected(
          yield* zipBytes(
            withManifest(files, (manifest) => ({
              ...manifest,
              entries: manifest.entries.map((entry) =>
                entry.path === SCIC_MARKDOWN_ENTRY
                  ? { ...entry, byteLength: entry.byteLength + 1 }
                  : entry,
              ),
            })),
          ),
          "manifest-mismatch",
          SCIC_MARKDOWN_ENTRY,
        );
        const pdf = pdfPath(pkg).path;
        yield* expectRejected(
          yield* zipBytes(files.filter((file) => file.path !== pdf)),
          "manifest-mismatch",
          pdf,
        );
      }),
    );

    it.effect("undeclared extra files", () =>
      Effect.gen(function* () {
        yield* expectRejected(
          yield* zipBytes([...makePackage().files, { path: "notes.txt", bytes: PNG }]),
          "undeclared-entry",
          "notes.txt",
        );
      }),
    );

    it.effect("reports entry names that always fit the rejection contract", () =>
      Effect.gen(function* () {
        // A name of spaces only is reported as no name at all.
        yield* expectRejected(
          yield* zipBytes([...makePackage().files, { path: "   ", bytes: PNG }]),
          "undeclared-entry",
          null,
        );
        // A long name is cut at 512 units, never inside a surrogate pair, and trimmed.
        const long = `${"a".repeat(509)} b😀c`;
        const entry = `${"a".repeat(509)} b`;
        yield* expectRejected(
          yield* zipBytes([...makePackage().files, { path: long, bytes: PNG }]),
          "unsafe-path",
          entry,
        );
        for (const name of [entry, reportedEntryName("  \t "), reportedEntryName(long)]) {
          expect(Exit.isSuccess(decodeRejection({ reason: "undeclared-entry", entry: name }))).toBe(
            true,
          );
        }
      }),
    );

    it.effect("unsupported major versions, and unknown content", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const encoded = encodeSnapshot(pkg.snapshot);
        const attachments = pkg.files.filter((file) => file.path.startsWith("attachments/"));
        yield* expectRejected(
          yield* zipBytes(
            assemble({
              snapshot: encoded,
              manifest: { ...pkg.manifest, formatVersion: { major: 2, minor: 0 } },
              attachments,
            }),
          ),
          "unsupported-version",
        );
        // A newer minor version may add manifest data; it imports with a warning.
        const newer = yield* read(
          yield* zipBytes(
            assemble({
              snapshot: encoded,
              manifest: { ...pkg.manifest, formatVersion: { major: 1, minor: 3 } },
              attachments,
            }),
          ),
        );
        if (Exit.isFailure(newer.exit)) throw new Error(String(newer.exit.cause));
        expect(newer.exit.value.warnings).toContainEqual({
          _tag: "newer-minor-version",
          formatVersion: { major: 1, minor: 3 },
        });
        // Snapshot content this build does not know is not silently dropped.
        const extended = { ...encoded, annotations: [{ note: "new in 1.3" }] };
        yield* expectRejected(
          yield* zipBytes(
            assemble({
              snapshot: extended,
              manifest: { ...pkg.manifest, formatVersion: { major: 1, minor: 3 } },
              attachments,
            }),
          ),
          "unsupported-version",
          SCIC_SNAPSHOT_ENTRY,
        );
        yield* expectRejected(
          yield* zipBytes(assemble({ snapshot: extended, manifest: pkg.manifest, attachments })),
          "snapshot-invalid",
          SCIC_SNAPSHOT_ENTRY,
        );
      }),
    );

    it.effect(
      "content edited under its old digest, and a snapshot that disagrees with its manifest",
      () =>
        Effect.gen(function* () {
          const pkg = makePackage();
          const encoded = encodeSnapshot(pkg.snapshot);
          const attachments = pkg.files.filter((file) => file.path.startsWith("attachments/"));
          const edited = {
            ...encoded,
            messages: encoded.messages.map((message) =>
              message.n === 2 ? { ...message, text: "Something else entirely." } : message,
            ),
          };
          yield* expectRejected(
            yield* zipBytes(assemble({ snapshot: edited, manifest: pkg.manifest, attachments })),
            "snapshot-invalid",
            SCIC_SNAPSHOT_ENTRY,
          );
          yield* expectRejected(
            yield* zipBytes(
              assemble({
                snapshot: encoded,
                manifest: { ...pkg.manifest, sourceThreadId: "thread-other" },
                attachments,
              }),
            ),
            "snapshot-invalid",
            SCIC_SNAPSHOT_ENTRY,
          );
        }),
    );

    it.effect("one flipped bit anywhere in an entry's content", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const clean = yield* zipBytes(pkg.files);
        // A stored attachment: the flip survives decompression, so the checksum catches it.
        const stored = Buffer.from(clean);
        const at = stored.indexOf(Buffer.from(PNG.subarray(0, 8)), 100);
        stored[at + 12]! ^= 0x01;
        yield* expectRejected(stored, "corrupt-archive");
        // A deflated document.
        const deflated = Buffer.from(clean);
        patchHeaders(deflated, SCIC_SNAPSHOT_ENTRY, (offset, kind) => {
          if (kind !== "local") return;
          const dataStart =
            offset + 30 + deflated.readUInt16LE(offset + 26) + deflated.readUInt16LE(offset + 28);
          deflated[dataStart + 20]! ^= 0x01;
        });
        yield* expectRejected(deflated, "corrupt-archive");
      }),
    );

    it.effect("attachment content that contradicts its declared type", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const pdf = pdfPath(pkg);
        // Same length, not a PDF: the snapshot is unchanged, only the bytes lie.
        const forged = new Uint8Array(PDF.byteLength).fill(0x41);
        const forgedPath = scicAttachmentPath(sha256Digest(forged), pdf.name);
        const manifest: ScicManifest = {
          ...pkg.manifest,
          resources: pkg.manifest.resources.map((resource) =>
            resource.id === pdf.id
              ? { ...pdf, path: forgedPath, sha256: sha256Digest(forged) }
              : resource,
          ),
        };
        yield* expectRejected(
          yield* zipBytes(
            assemble({
              snapshot: encodeSnapshot(pkg.snapshot),
              manifest,
              attachments: [
                ...pkg.files.filter(
                  (file) => file.path.startsWith("attachments/") && file.path !== pdf.path,
                ),
                { path: forgedPath, bytes: forged },
              ],
              mediaTypes: new Map([[forgedPath, "application/pdf"]]),
            }),
          ),
          "attachment-type-mismatch",
          forgedPath,
        );
      }),
    );

    it.effect("validates every distinct entry even when attachments claim one digest", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const original = pkg.manifest.resources.find(
          (resource) => resource._tag === "included" && resource.mediaType === "image/png",
        );
        if (original?._tag !== "included") throw new Error("image fixture missing");
        const duplicateId = "attachment-4";
        const archive = (name: string, kind: "image" | "file", mediaType: string) => {
          const duplicatePath = scicAttachmentPath(original.sha256, name);
          const encoded = encodeSnapshot(pkg.snapshot);
          const changed = {
            ...encoded,
            messages: encoded.messages.map((message) =>
              message.n === 1
                ? {
                    ...message,
                    attachments: [
                      ...message.attachments,
                      attachment(duplicateId, kind, name, mediaType, PNG.byteLength),
                    ],
                  }
                : message,
            ),
          };
          const snapshot = {
            ...changed,
            contentDigest: conversationContentDigest(decodeSnapshot(changed)),
          };
          const manifest: ScicManifest = {
            ...pkg.manifest,
            contentDigest: snapshot.contentDigest,
            resources: [
              ...pkg.manifest.resources,
              {
                ...original,
                id: duplicateId,
                path: duplicatePath,
                name,
                kind,
                mediaType,
              },
            ],
          };
          const files = assemble({
            snapshot,
            manifest,
            attachments: [
              ...pkg.files.filter((file) => file.path.startsWith("attachments/")),
              { path: duplicatePath, bytes: PNG },
            ],
            mediaTypes: new Map([[duplicatePath, mediaType]]),
          });
          return { files, duplicatePath };
        };

        const valid = archive("copy.png", "image", "image/png");
        const accepted = yield* read(yield* zipBytes(valid.files));
        if (Exit.isFailure(accepted.exit)) throw new Error(String(accepted.exit.cause));
        expect(accepted.exit.value.attachments).toHaveLength(3);

        const corruptBytes = Uint8Array.from(PNG);
        corruptBytes[corruptBytes.length - 1]! ^= 1;
        yield* expectRejected(
          yield* zipBytes(
            valid.files.map((file) =>
              file.path === valid.duplicatePath ? { ...file, bytes: corruptBytes } : file,
            ),
          ),
          "manifest-mismatch",
          valid.duplicatePath,
        );

        const wrongType = archive("copy.pdf", "file", "application/pdf");
        yield* expectRejected(
          yield* zipBytes(wrongType.files),
          "attachment-type-mismatch",
          wrongType.duplicatePath,
        );
      }),
    );

    it.effect("attachments outside the media policy", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        const image = pkg.manifest.resources.find((resource) => resource.id === "attachment-1")!;
        if (image._tag !== "included") throw new Error("fixture");
        const encoded = encodeSnapshot(pkg.snapshot);
        const snapshot = {
          ...encoded,
          messages: encoded.messages.map((message) => ({
            ...message,
            attachments: message.attachments.map((item) =>
              item.localId === image.id ? { ...item, mimeType: "image/svg+xml" } : item,
            ),
          })),
        };
        const resealed = {
          ...snapshot,
          contentDigest: conversationContentDigest(decodeSnapshot(snapshot)),
        };
        yield* expectRejected(
          yield* zipBytes(
            assemble({
              snapshot: resealed,
              manifest: {
                ...pkg.manifest,
                contentDigest: resealed.contentDigest,
                resources: pkg.manifest.resources.map((resource) =>
                  resource.id === image.id ? { ...image, mediaType: "image/svg+xml" } : resource,
                ),
              },
              attachments: pkg.files.filter((file) => file.path.startsWith("attachments/")),
              mediaTypes: new Map([[image.path, "image/svg+xml"]]),
            }),
          ),
          "attachment-policy",
          image.path,
        );
      }),
    );

    it.effect("a malformed manifest", () =>
      Effect.gen(function* () {
        const pkg = makePackage();
        yield* expectRejected(
          yield* zipBytes(
            pkg.files.map((file) =>
              file.path === SCIC_MANIFEST_ENTRY
                ? { ...file, bytes: encoder.encode("{nope") }
                : file,
            ),
          ),
          "manifest-invalid",
          SCIC_MANIFEST_ENTRY,
        );
      }),
    );
  });
});
