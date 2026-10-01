import {
  EnvironmentFileLinkResolveInput,
  EnvironmentFilePath,
  type EnvironmentFileLinkResolution,
} from "@t3tools/contracts";
import {
  collapseAbsoluteFilePath,
  workspaceRelativeFilePath,
} from "@t3tools/client-runtime/markdown-links";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolvePathLinkTarget } from "~/terminal-links";

const decodeResolveInput = Schema.decodeUnknownOption(EnvironmentFileLinkResolveInput);
const isEnvironmentFilePath = Schema.is(EnvironmentFilePath);
/** Mirrors the resolver contract's bound on changed files. */
const MAX_CHANGED_PATHS = 2_000;

/**
 * The request that asks the environment what a chat link means, or null when
 * there is nothing to ask: a thread without a workspace, or a path the
 * environment cannot take. The link then opens as written.
 */
export function chatFileLinkResolveInput(input: {
  /** The link's path: workspace-relative or absolute. */
  readonly linkPath: string;
  readonly workspaceRoot: string | undefined;
  /** Files the link's turn changed, relative to the workspace. */
  readonly changedPaths: ReadonlyArray<string>;
}): EnvironmentFileLinkResolveInput | null {
  if (!input.workspaceRoot) return null;
  // Changed files only break a tie, and a partial list could break one
  // wrongly: when a turn changed more than can be sent, none are, and a tie
  // stays a choice.
  const changedPaths =
    input.changedPaths.length > MAX_CHANGED_PATHS
      ? []
      : input.changedPaths.filter(isEnvironmentFilePath);
  return Option.getOrNull(
    decodeResolveInput({
      workspaceRoot: input.workspaceRoot,
      path: input.linkPath,
      changedPaths,
    }),
  );
}

/**
 * A link written from the home folder (`~/notes.md`). Only the environment
 * that owns the files knows where its home folder is, so the client never
 * expands one itself when it can ask.
 */
export function isHomeRelativeLink(path: string): boolean {
  return path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * Where the client itself would place a link. A home-relative link is placed
 * by guessing the home folder from the workspace's own location, which is
 * right only for a workspace under a conventional home; it is the fallback
 * for an environment that cannot say. Any other link is already placed.
 */
export function clientPlacedLinkPath(linkPath: string, workspaceRoot: string | undefined): string {
  if (!isHomeRelativeLink(linkPath) || !workspaceRoot) return linkPath;
  const guessed = collapseAbsoluteFilePath(resolvePathLinkTarget(linkPath, workspaceRoot));
  return workspaceRelativeFilePath(guessed, workspaceRoot) ?? guessed;
}

/**
 * What a click on a chat link does with the environment's answer.
 *
 * - `as-written`: the link's own location is the file (it exists, or fails for
 *   a real reason that opening it will show), or the environment could not be
 *   asked.
 * - `resolved`: nothing exists at the link's location and one workspace file
 *   is what it meant; open that file and say so.
 * - `missing`: nothing exists there and there is no single answer; open the
 *   link as written so the file panel explains and offers the choices.
 */
export type ChatFileOpenPlan =
  | { readonly kind: "as-written" }
  | { readonly kind: "resolved"; readonly path: string; readonly missingPath: string }
  | { readonly kind: "missing" };

export function chatFileOpenPlan(
  resolution: EnvironmentFileLinkResolution | null,
): ChatFileOpenPlan {
  switch (resolution?._tag) {
    case undefined:
    case "literal":
      return { kind: "as-written" };
    case "recovered":
      return { kind: "resolved", path: resolution.path, missingPath: resolution.missingPath };
    case "tie":
    case "none":
    case "incomplete":
      return { kind: "missing" };
  }
}

/**
 * The path a link opens at when it opens as written. Ordinarily that is the
 * client's own spelling. A home-relative link has no spelling the client can
 * trust, so it opens where the environment says the link's location is: the
 * file it found there, or the location it checked and found empty. That
 * location stays a workspace path when it is inside the workspace, so the
 * file stays editable.
 *
 * `clientPath` is the client's own placement of the link, used when the
 * environment could not be asked or predates home-folder expansion (it then
 * reports the unexpanded `~` under the workspace for a missing file).
 */
export function linkOpenLocation(input: {
  readonly resolution: EnvironmentFileLinkResolution | null;
  /** The link as the environment was asked about it. */
  readonly askedPath: string;
  readonly clientPath: string;
  readonly workspaceRoot: string | undefined;
}): string {
  const { resolution } = input;
  if (resolution === null || !isHomeRelativeLink(input.askedPath)) return input.clientPath;
  if (resolution._tag === "recovered") return input.clientPath;
  const reported = resolution._tag === "literal" ? resolution.path : resolution.missingPath;
  const location = workspaceRelativeFilePath(reported, input.workspaceRoot) ?? reported;
  return resolution._tag !== "literal" && isHomeRelativeLink(location)
    ? input.clientPath
    : location;
}

/**
 * Waits for `pending` at most `waitMs`, then answers `fallback`. A stalled
 * connection must not swallow a click: past the wait the link opens as
 * written. A rejection is treated the same way.
 */
export function settleWithin<T>(pending: Promise<T>, waitMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(resolve, waitMs, fallback);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Marks a link click as the user's latest intent and returns a check for
 * whether it still is. A newer link click, or anything the user did in the
 * panel since, supersedes it, so a slow answer never replaces a newer choice.
 */
export function claimLinkClick(input: {
  /** Claims the shared click sequence; the result says whether it is still the latest. */
  readonly claimLatest: () => () => boolean;
  /** The panel's count of user actions, read at the click and again later. */
  readonly readUserActionRevision: () => number;
}): () => boolean {
  const isLatest = input.claimLatest();
  const revision = input.readUserActionRevision();
  return () => isLatest() && input.readUserActionRevision() === revision;
}
