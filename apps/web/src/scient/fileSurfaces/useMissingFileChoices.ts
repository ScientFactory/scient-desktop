import { collapseAbsoluteFilePath } from "@t3tools/client-runtime/markdown-links";
import type {
  EnvironmentFileLinkResolution,
  EnvironmentId,
  ProjectFileErrorReason,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { chatFileLinkResolveInput } from "~/scient/fileOpening/chatFileLinkResolution";
import { environmentFileLinkResolution } from "~/scient/fileOpening/environmentFileState";
import { useEnvironmentQuery } from "~/state/query";
import { workspaceFileHostPath } from "~/components/files/filePath";
import { isAbsolutePath } from "~/terminal-links";

export interface MissingFileChoices {
  /** Workspace files a missing path may have meant, as explicit choices. */
  readonly paths: ReadonlyArray<string>;
  /** The workspace could not be searched completely; there may be others. */
  readonly incomplete: boolean;
}

const NO_CHOICES: MissingFileChoices = { paths: [], incomplete: false };

/**
 * The files to offer for a path that was not found. The panel never opens one
 * by itself: a tab can lose its file for reasons a link click does not have,
 * such as a rename while it was open, so even a single match is a choice here.
 */
export function missingFileChoices(
  resolution: EnvironmentFileLinkResolution | null,
): MissingFileChoices {
  switch (resolution?._tag) {
    case "recovered":
      return { paths: [resolution.path], incomplete: false };
    case "tie":
      return { paths: resolution.paths, incomplete: false };
    case "incomplete":
      return { paths: resolution.paths, incomplete: true };
    default:
      return NO_CHOICES;
  }
}

/**
 * The question to ask about a tab whose file is missing. It names the tab's
 * exact location: a tab's path is a locator, not a link, so a workspace folder
 * really named `~` is asked about as that folder, never as the home folder.
 */
export function missingFileResolveInput(input: {
  /** The tab's host path, already joined to the workspace root. */
  readonly absolutePath: string | null;
  readonly cwd: string;
  readonly failureReason: ProjectFileErrorReason | null;
}) {
  return input.absolutePath !== null && input.failureReason === "not_found"
    ? chatFileLinkResolveInput({
        linkPath: input.absolutePath,
        workspaceRoot: input.cwd,
        changedPaths: [],
      })
    : null;
}

/**
 * What a file surface shows when nothing exists at a tab's path: the exact
 * location that was tried, and the workspace files it may have meant. The
 * environment that owns the files decides both, as it does for a link click.
 */
export function useMissingFileChoices(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string | null;
  readonly failureReason: ProjectFileErrorReason | null;
}): { readonly absolutePath: string | null } & MissingFileChoices {
  const { cwd, environmentId, path } = input;
  const absolutePath = useMemo(() => {
    if (path === null || path.length === 0) return null;
    if (isAbsolutePath(path)) return collapseAbsoluteFilePath(path);
    return cwd ? collapseAbsoluteFilePath(workspaceFileHostPath(path, cwd)) : null;
  }, [cwd, path]);
  const resolveInput = useMemo(
    () => missingFileResolveInput({ absolutePath, cwd, failureReason: input.failureReason }),
    [absolutePath, cwd, input.failureReason],
  );
  const resolution = useEnvironmentQuery(
    resolveInput === null
      ? null
      : environmentFileLinkResolution({ environmentId, input: resolveInput }),
  );
  const choices = useMemo(() => missingFileChoices(resolution.data), [resolution.data]);
  return { absolutePath, ...choices };
}
