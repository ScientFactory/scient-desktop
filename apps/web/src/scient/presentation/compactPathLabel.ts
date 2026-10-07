import { formatWorkspaceRelativePath } from "../../filePathDisplay";

const PATH_START = /^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])/u;
const KEPT_SEGMENTS = 2;

/**
 * A collapsed trace row names a file by its last two path segments
 * (`Layers/ProviderCommandReactor.ts`), not its full path. Text that is not a
 * single path is returned unchanged; the full path stays in the expanded row.
 */
export function compactPathLabel(text: string, workspaceRoot: string | undefined): string {
  const trimmed = text.trim();
  if (!PATH_START.test(trimmed) || /[\r\n]/u.test(trimmed)) return text;
  const segments = formatWorkspaceRelativePath(trimmed, workspaceRoot)
    .split(/[\\/]/u)
    .filter(Boolean);
  if (segments.length <= KEPT_SEGMENTS) return segments.join("/") || text;
  return segments.slice(-KEPT_SEGMENTS).join("/");
}
