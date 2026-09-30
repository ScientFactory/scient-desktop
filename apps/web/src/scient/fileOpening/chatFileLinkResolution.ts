import {
  EnvironmentFileLinkResolveInput,
  EnvironmentFilePath,
  type EnvironmentFileLinkResolution,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  return Option.getOrNull(
    decodeResolveInput({
      workspaceRoot: input.workspaceRoot,
      path: input.linkPath,
      changedPaths: input.changedPaths.filter(isEnvironmentFilePath).slice(0, MAX_CHANGED_PATHS),
    }),
  );
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
