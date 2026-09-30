import { collapseAbsoluteFilePath, fileBasename } from "@t3tools/client-runtime/markdown-links";
import type { EnvironmentId, ProjectEntry, ProjectFileErrorReason } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { toastManager } from "~/components/ui/toast";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useProjectPathSearch } from "~/state/queries";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";

const CANDIDATE_SEARCH_LIMIT = 25;
const MAX_CANDIDATES = 5;

/**
 * Same-named project files for a path that was not found, as explicit choices.
 * Only exact basename matches count, and the missing path itself never does;
 * the caller shows them and the user picks, because two files can share a name.
 */
export function missingFileCandidates(
  path: string,
  entries: ReadonlyArray<Pick<ProjectEntry, "path" | "kind">>,
): string[] {
  const basename = fileBasename(path);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.path === path) continue;
    if (fileBasename(entry.path) !== basename || candidates.includes(entry.path)) continue;
    candidates.push(entry.path);
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return candidates;
}

/**
 * Whether System Settings can help with a denied read: only when the file is
 * on this Mac and the desktop shell can open the settings. A remote machine's
 * permissions, and other platforms, have no such shortcut.
 */
export function canOfferPrivacySettings(input: {
  readonly failureReason: ProjectFileErrorReason | null;
  readonly isLocalEnvironment: boolean;
  readonly platform: string;
  readonly hasSystemSettingsBridge: boolean;
}): boolean {
  return (
    input.failureReason === "permission_denied" &&
    input.isLocalEnvironment &&
    isMacPlatform(input.platform) &&
    input.hasSystemSettingsBridge
  );
}

/**
 * What a file surface can offer when a read failed: the exact location that
 * was tried, same-named files in the project when nothing exists there, and a
 * shortcut to the system privacy settings when this machine denied access.
 */
export function useMissingFileRecovery(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string | null;
  readonly failureReason: ProjectFileErrorReason | null;
  /** Privacy settings only help when the file lives on this machine. */
  readonly isLocalEnvironment: boolean;
}): {
  readonly absolutePath: string | null;
  readonly candidates: ReadonlyArray<string>;
  readonly onOpenPrivacySettings: (() => void) | null;
} {
  const { cwd, path } = input;
  const absolutePath = useMemo(() => {
    if (path === null || path.length === 0) return null;
    if (isAbsolutePath(path)) return collapseAbsoluteFilePath(path);
    return cwd ? collapseAbsoluteFilePath(resolvePathLinkTarget(path, cwd)) : null;
  }, [cwd, path]);
  const searchesCandidates = path !== null && cwd.length > 0 && input.failureReason === "not_found";
  const search = useProjectPathSearch(
    {
      environmentId: searchesCandidates ? input.environmentId : null,
      cwd: searchesCandidates ? cwd : null,
      query: searchesCandidates ? fileBasename(path) : null,
      kind: "file",
    },
    CANDIDATE_SEARCH_LIMIT,
  );
  const candidates = useMemo(
    () => (searchesCandidates ? missingFileCandidates(path, search.entries) : []),
    [path, search.entries, searchesCandidates],
  );
  const canOpenPrivacySettings = canOfferPrivacySettings({
    failureReason: input.failureReason,
    isLocalEnvironment: input.isLocalEnvironment,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
    hasSystemSettingsBridge:
      typeof window !== "undefined" && window.desktopBridge?.openSystemSettings !== undefined,
  });
  const openPrivacySettings = useCallback(() => {
    void readLocalApi()
      ?.shell.openSystemSettings("full-disk-access")
      .catch(() => {
        toastManager.add({
          type: "error",
          title: "Could not open System Settings",
          description: "Open Privacy & Security → Full Disk Access manually.",
        });
      });
  }, []);
  return {
    absolutePath,
    candidates,
    onOpenPrivacySettings: canOpenPrivacySettings ? openPrivacySettings : null,
  };
}
