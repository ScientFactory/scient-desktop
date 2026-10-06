/**
 * The rooted "workspace-file" asset locator: cwd + relativePath name a document,
 * while the legacy thread pair stays accepted during client/server version skew.
 * assets.ts applies the locator filter where the resource union is declared.
 */
import * as Schema from "effect/Schema";

import { FilePathString, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const WORKSPACE_ASSET_PATH_MAX_LENGTH = 1_024;

const WorkspaceRootPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKSPACE_ASSET_PATH_MAX_LENGTH),
);
// A file locator keeps its whitespace: it names one exact file.
const WorkspaceFilePath = FilePathString.check(Schema.isMaxLength(WORKSPACE_ASSET_PATH_MAX_LENGTH));

export const WorkspaceFileAssetResource = Schema.TaggedStruct("workspace-file", {
  // SCIENT-WORKSPACE-ASSET: cwd + relativePath are the document locator.
  // The legacy thread pair remains optional during client/server version skew.
  cwd: Schema.optional(WorkspaceRootPath),
  relativePath: Schema.optional(WorkspaceFilePath),
  threadId: Schema.optional(ThreadId),
  path: Schema.optional(WorkspaceFilePath),
});

export const workspaceFileLocatorFilter = Schema.makeFilter(
  (input: typeof WorkspaceFileAssetResource.Type) => {
    const hasRootedLocator = input.cwd !== undefined || input.relativePath !== undefined;
    const hasLegacyLocator = input.threadId !== undefined || input.path !== undefined;
    if (!hasRootedLocator && !hasLegacyLocator) {
      return "A workspace file requires a rooted or legacy locator.";
    }
    if ((input.cwd === undefined) !== (input.relativePath === undefined)) {
      return "cwd and relativePath must be provided together.";
    }
    if ((input.threadId === undefined) !== (input.path === undefined)) {
      return "threadId and path must be provided together.";
    }
    return true;
  },
  { identifier: "WorkspaceFileAssetResource" },
);
