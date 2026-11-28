// @effect-diagnostics nodeBuiltinImport:off - Notes are stored with the project's transcripts.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const Recipe = Schema.Literals([
  "summary",
  "study-notes",
  "action-items",
  "lesson",
  "meeting",
  "interview",
]);

const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({ threadId: ThreadId, recipe: Recipe }),
);
const manifestName = /^notes-[a-f0-9-]{36}\.json$/;
const maxNoteBytes = 1024 * 1024;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function readNotesFile(path: string, limit: number) {
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid notes file");
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function listRecordingNoteFiles(project: string, relativeDirectory: string) {
  const directory = NodePath.join(project, relativeDirectory);
  const stat = await NodeFSP.lstat(directory).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error("Invalid recording notes directory.");
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  const notes = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && manifestName.test(entry.name))
      .map(async ({ name }) => {
        const manifest = decodeManifest(
          JSON.parse(await readNotesFile(NodePath.join(directory, name), 4096)),
        );
        const file = name.replace(/\.json$/, ".md");
        const path = NodePath.join(directory, file);
        const info = await NodeFSP.lstat(path).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
        return {
          ...manifest,
          path: NodePath.posix.join(relativeDirectory, file),
          text:
            info?.isFile() && info.size <= maxNoteBytes
              ? await readNotesFile(path, maxNoteBytes)
              : null,
          created: info?.mtimeMs ?? 0,
        };
      }),
  );
  return notes.sort(
    (left, right) => right.created - left.created || left.path.localeCompare(right.path),
  );
}
