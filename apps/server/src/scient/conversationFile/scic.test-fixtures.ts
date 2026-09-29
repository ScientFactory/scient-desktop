// @effect-diagnostics nodeBuiltinImport:off -- fixture packages are built as ZIP bytes in memory.
/**
 * Shared `.scic` fixtures for tests: a captured snapshot with an image, a
 * PDF, and an unavailable attachment; its package; and a ZIP builder that can
 * write whatever a test needs, including invalid archives.
 */
import { ConversationSnapshotV1 } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as yazl from "yazl";

import { prepareScicPackage, sha256Digest, type ScicPackage } from "./ScicWriter.ts";

export const STATE_ROOT = "/Users/someone/.scient-next/userdata";

export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01,
]);
export const PDF = new TextEncoder().encode("%PDF-1.7\nfixture body that is long enough\n%%EOF\n");

export const decodeSnapshot = Schema.decodeUnknownSync(ConversationSnapshotV1);
export const encodeSnapshot = Schema.encodeSync(ConversationSnapshotV1);

export const attachment = (
  localId: string,
  kind: "image" | "file" | "other",
  name: string,
  mimeType: string,
  sizeBytes: number,
  available = true,
) => ({ localId, kind, name, mimeType, sizeBytes, pastedText: false, available });

export const capturedSnapshot = decodeSnapshot({
  format: "scient.conversation-snapshot",
  version: 1,
  thread: {
    title: "Export design",
    createdAt: "2026-09-27T14:00:00.000Z",
    updatedAt: "2026-09-27T15:00:00.000Z",
    provider: "codex",
    model: "gpt-5",
  },
  provenance: { _tag: "original" },
  captured: {
    threadId: "thread-1",
    snapshotSequence: 42,
    threadSequence: 40,
    capturedAt: "2026-09-27T15:00:01.000Z",
  },
  selection: { workLog: false, reasoning: false, throughMessageId: null },
  messages: [
    {
      n: 1,
      id: "message-1",
      role: "user",
      turnId: null,
      createdAt: "2026-09-27T14:05:00.000Z",
      updatedAt: "2026-09-27T14:05:00.000Z",
      text: `Look at [figure.png](scient-ref:r1) and the log in ${STATE_ROOT}/logs/server.log`,
      attachments: [
        attachment("thread-1-aaaa", "image", "figure.png", "image/png", PNG.byteLength),
        attachment("thread-1-bbbb", "file", "paper.pdf", "application/pdf", PDF.byteLength),
        attachment("thread-1-cccc", "file", "gone.csv", "text/csv", 10, false),
      ],
      references: [
        {
          _tag: "attachment",
          id: "r1",
          label: "figure.png",
          attachmentLocalId: "thread-1-aaaa",
          image: true,
        },
      ],
    },
    {
      n: 2,
      id: "message-2",
      role: "assistant",
      turnId: "turn-1",
      createdAt: "2026-09-27T14:06:00.000Z",
      updatedAt: "2026-09-27T14:06:00.000Z",
      text: "Here is what I found.",
      attachments: [],
      references: [],
    },
  ],
  reasoning: [],
  workLog: [],
  proposedPlans: [],
  questionAnswers: [],
  omittedRunningTurn: null,
  warnings: [{ _tag: "attachment-unavailable", name: "gone.csv", messageN: 1 }],
  contentDigest: `sha256:${"0".repeat(64)}`,
});

const redact = (text: string) => text.split(STATE_ROOT).join("«scient-data»");

export function makePackage(
  snapshot = capturedSnapshot,
  attachments = new Map([
    ["thread-1-aaaa", { _tag: "bytes" as const, bytes: PNG, sha256: sha256Digest(PNG) }],
    ["thread-1-bbbb", { _tag: "bytes" as const, bytes: PDF, sha256: sha256Digest(PDF) }],
  ]),
): ScicPackage {
  const prepared = prepareScicPackage({
    snapshot,
    attachments,
    exportValue: "7f3c9a2e41b8",
    exportedAt: "2026-09-28T09:12:00.000Z",
    exporter: { name: "Scient", version: "0.7.0" },
    timeZone: "UTC",
    redact,
  });
  if (prepared._tag !== "ok") throw new Error(`Could not prepare the fixture: ${prepared._tag}`);
  return prepared.value;
}

export interface ZipFileSpec {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly compress?: boolean;
  readonly mode?: number;
}

export function zipBytesPromise(files: ReadonlyArray<ZipFileSpec>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
    for (const file of files) {
      zip.addBuffer(Buffer.from(file.bytes), file.path, {
        mtime: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-28T09:12:00.000Z")),
        mode: file.mode ?? 0o100644,
        compress: file.compress ?? true,
      });
    }
    zip.end();
  });
}

/** Name pieces that stress code-point handling: astral letters, CJK, combining marks, emoji, RTL. */
const NAME_PIECES = [
  "研究",
  "結果",
  "𝒜",
  "𠀀",
  "𝟙",
  "é",
  "é",
  "q̃",
  "İ",
  "ß",
  "🧪",
  "👩‍🔬",
  "ب",
  "א",
  "क्ष",
  "‍",
  ".",
  " ",
  "-",
  "_",
  "a",
  "Z",
  "9",
  ".png",
];

/**
 * Deterministic attachment-style names (at most 255 UTF-16 units, as chat
 * attachments allow) for property-style tests.
 */
export function generatedNames(count: number, seed = 0x5c1e47): ReadonlyArray<string> {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: count }, () => {
    const pieces = 1 + Math.floor(next() * 160);
    let name = "";
    for (let index = 0; index < pieces; index += 1) {
      const piece = NAME_PIECES[Math.floor(next() * NAME_PIECES.length)]!;
      if (name.length + piece.length > 255) break;
      name += piece;
    }
    return name.trim() || "x";
  });
}
