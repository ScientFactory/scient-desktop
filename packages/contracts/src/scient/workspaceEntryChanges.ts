import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { DirectoryPathString, FilePathString, TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * What the Files panel does to a project's files and folders by hand: new
 * files and folders, moves and renames, copies, the Trash and its undo. Paths are
 * relative to the project, with "/" between names.
 */
const EntryPath = FilePathString.check(Schema.isMaxLength(4_096));
const MAX_ENTRIES = 1_000;

/** When a destination name is taken: report it, move the existing item to the Trash, or pick a free name. */
export const WorkspaceEntryCollision = Schema.Literals(["ask", "replace", "keep-both"]);
export type WorkspaceEntryCollision = typeof WorkspaceEntryCollision.Type;

export const WorkspaceEntryTransferItem = Schema.Struct({ from: EntryPath, to: EntryPath });
export type WorkspaceEntryTransferItem = typeof WorkspaceEntryTransferItem.Type;

const TransferItems = Schema.Array(WorkspaceEntryTransferItem).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ENTRIES),
);

export const WorkspaceEntryChange = Schema.Union([
  /** A new empty folder or file; a taken name becomes "name 2", "name 3". */
  Schema.TaggedStruct("create-folder", { relativePath: EntryPath }),
  Schema.TaggedStruct("create-file", { relativePath: EntryPath }),
  Schema.TaggedStruct("move", { items: TransferItems, collision: WorkspaceEntryCollision }),
  Schema.TaggedStruct("copy", { items: TransferItems, collision: WorkspaceEntryCollision }),
  Schema.TaggedStruct("trash", {
    relativePaths: Schema.Array(EntryPath).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ENTRIES),
    ),
  }),
  /**
   * Copies files and folders from elsewhere on the server's computer (absolute
   * paths, as a drop from Finder or a picker gives them) into `folder`.
   */
  Schema.TaggedStruct("import", {
    sources: Schema.Array(EntryPath).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ENTRIES)),
    folder: DirectoryPathString.check(Schema.isMaxLength(4_096)),
    collision: WorkspaceEntryCollision,
  }),
  /** Puts items this server moved to the Trash back where they were. */
  Schema.TaggedStruct("restore", {
    restoreIds: Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ENTRIES),
    ),
  }),
]);
export type WorkspaceEntryChange = typeof WorkspaceEntryChange.Type;

export const WorkspaceEntryChangeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  change: WorkspaceEntryChange,
});
export type WorkspaceEntryChangeInput = typeof WorkspaceEntryChangeInput.Type;

/**
 * One changed entry. `from` is where it was (absent for a new folder); `to` is
 * where it is now (absent for an item moved to the Trash). An item in the
 * Trash carries `restoreId` when this server can put it back.
 */
export const WorkspaceEntryChangeOutcome = Schema.Struct({
  from: Schema.optional(EntryPath),
  to: Schema.optional(EntryPath),
  restoreId: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceEntryChangeOutcome = typeof WorkspaceEntryChangeOutcome.Type;

export const WorkspaceEntryChangeResult = Schema.Struct({
  entries: Schema.Array(WorkspaceEntryChangeOutcome),
});
export type WorkspaceEntryChangeResult = typeof WorkspaceEntryChangeResult.Type;

export const WorkspaceEntryChangeFailure = Schema.Literals([
  /** A destination name is taken; `paths` lists them. */
  "exists",
  /** A source is gone; `paths` lists it. */
  "missing",
  /** A folder would go inside itself. */
  "into-itself",
  /** Outside the project, inside Git's own files, or a part of the project Files only shows. */
  "not-allowed",
  /** This computer has no Trash Scient can use. */
  "trash-unavailable",
  /** The restore ids are unknown here, such as after the server restarted. */
  "restore-unavailable",
  "failed",
]);
export type WorkspaceEntryChangeFailure = typeof WorkspaceEntryChangeFailure.Type;

export class WorkspaceEntryChangeError extends Schema.TaggedError<WorkspaceEntryChangeError>()(
  "WorkspaceEntryChangeError",
  {
    failure: WorkspaceEntryChangeFailure,
    paths: Schema.optional(Schema.Array(EntryPath)),
    /** What already changed before the failure, so the client can show and undo it. */
    completed: Schema.optional(Schema.Array(WorkspaceEntryChangeOutcome)),
    message: TrimmedNonEmptyString,
  },
) {}

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_WORKSPACE_ENTRY_WS_METHODS = {
  projectsChangeEntries: "projects.changeEntries",
  projectsOpenWithApps: "projects.openWithApps",
  projectsOpenWith: "projects.openWith",
} as const;

export const WsProjectsChangeEntriesRpc = Rpc.make(
  SCIENT_WORKSPACE_ENTRY_WS_METHODS.projectsChangeEntries,
  {
    payload: WorkspaceEntryChangeInput,
    success: WorkspaceEntryChangeResult,
    error: Schema.Union([WorkspaceEntryChangeError, EnvironmentAuthorizationError]),
  },
);

/** An entry of the project, for Open With. */
export const WorkspaceOpenWithTarget = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: EntryPath,
});
export type WorkspaceOpenWithTarget = typeof WorkspaceOpenWithTarget.Type;

/** An app the computer offers for an entry, as Finder's Open With lists it. */
export const WorkspaceOpenWithApp = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
});
export type WorkspaceOpenWithApp = typeof WorkspaceOpenWithApp.Type;

export const WorkspaceOpenWithApps = Schema.Struct({
  apps: Schema.Array(WorkspaceOpenWithApp),
  /** The computer has its own app chooser (Windows' "Open with" window). */
  chooser: Schema.Boolean,
});
export type WorkspaceOpenWithApps = typeof WorkspaceOpenWithApps.Type;

export const WorkspaceOpenWithInput = Schema.Struct({
  ...WorkspaceOpenWithTarget.fields,
  /** One of the listed apps, or the computer's own chooser. */
  app: Schema.Union([
    Schema.TaggedStruct("app", { id: TrimmedNonEmptyString }),
    Schema.TaggedStruct("chooser", {}),
  ]),
});
export type WorkspaceOpenWithInput = typeof WorkspaceOpenWithInput.Type;

export class WorkspaceOpenWithError extends Schema.TaggedError<WorkspaceOpenWithError>()(
  "WorkspaceOpenWithError",
  { message: TrimmedNonEmptyString },
) {}

export const WsProjectsOpenWithAppsRpc = Rpc.make(
  SCIENT_WORKSPACE_ENTRY_WS_METHODS.projectsOpenWithApps,
  {
    payload: WorkspaceOpenWithTarget,
    success: WorkspaceOpenWithApps,
    error: Schema.Union([WorkspaceOpenWithError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsOpenWithRpc = Rpc.make(SCIENT_WORKSPACE_ENTRY_WS_METHODS.projectsOpenWith, {
  payload: WorkspaceOpenWithInput,
  success: Schema.Struct({}),
  error: Schema.Union([WorkspaceOpenWithError, EnvironmentAuthorizationError]),
});
