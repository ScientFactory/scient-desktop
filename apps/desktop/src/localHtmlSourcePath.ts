// FILE: localHtmlSourcePath.ts
// Purpose: Canonicalizes local-HTML source authority without erasing Windows case sensitivity.
// Layer: Desktop local-preview security boundary

import { realpathSync } from "node:fs";
import * as Path from "node:path";

type Realpath = (value: string) => string;

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? Path.win32 : Path.posix;
}

export function normalizeLocalHtmlSourcePath(
  value: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!value?.trim()) return null;
  const api = pathApi(platform);
  if (!api.isAbsolute(value)) return null;
  return api.normalize(value.trim());
}

export function canonicalLocalHtmlSourcePath(
  value: string | null | undefined,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly realpath?: Realpath;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const normalized = normalizeLocalHtmlSourcePath(value, platform);
  if (!normalized) return null;
  const resolveRealpath = options.realpath ?? realpathSync.native;
  try {
    return normalizeLocalHtmlSourcePath(resolveRealpath(normalized), platform);
  } catch {
    try {
      const canonicalParent = resolveRealpath(api.dirname(normalized));
      return normalizeLocalHtmlSourcePath(
        api.join(canonicalParent, api.basename(normalized)),
        platform,
      );
    } catch {
      // Preserve the exact unresolved spelling. Lowercasing here can point at a
      // different file in a Windows directory with case sensitivity enabled.
      return normalized;
    }
  }
}

export function isCanonicalLocalHtmlPathInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const api = pathApi(platform);
  const normalizedCandidate = api.normalize(candidate);
  const normalizedRoot = api.normalize(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootPrefix = normalizedRoot.endsWith(api.sep)
    ? normalizedRoot
    : `${normalizedRoot}${api.sep}`;
  return normalizedCandidate.startsWith(rootPrefix);
}
