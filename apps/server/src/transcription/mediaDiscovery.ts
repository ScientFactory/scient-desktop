// @effect-diagnostics nodeBuiltinImport:off - A bounded walk of the project folder on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { isWorkspaceVideoPreviewPath } from "@t3tools/shared/filePreview";
import { isWorkspaceAudioPreviewPath } from "@t3tools/shared/mediaPreview";

export type DiscoveredMedia = { source: string; size: number; created: number; mtime: number };

const SKIPPED_FOLDERS = new Set(["node_modules", "__pycache__", "venv"]);

const isTranscribableMediaPath = (path: string) =>
  isWorkspaceAudioPreviewPath(path) || isWorkspaceVideoPreviewPath(path);

/** Audio and video files in the project, shallowest first. Hidden and dependency folders, the
 * project's own Transcripts folder and symbolic links are skipped; the walk stops at its limits. */
export async function discoverProjectMedia(
  project: string,
  limits = { entries: 20_000, depth: 12, media: 500 },
): Promise<DiscoveredMedia[]> {
  const found: DiscoveredMedia[] = [];
  let visited = 0;
  let level = [project];
  for (let depth = 0; level.length > 0 && depth <= limits.depth; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        visited += 1;
        if (visited > limits.entries || found.length >= limits.media) return found;
        if (entry.name.startsWith(".")) continue;
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name) && !(depth === 0 && entry.name === "Transcripts"))
            next.push(path);
        } else if (entry.isFile() && isTranscribableMediaPath(entry.name)) {
          const stat = await NodeFSP.stat(path).catch(() => undefined);
          if (stat?.isFile())
            found.push({
              source: path,
              size: stat.size,
              created: stat.birthtimeMs || stat.mtimeMs,
              mtime: stat.mtimeMs,
            });
        }
      }
    }
    level = next;
  }
  return found;
}
