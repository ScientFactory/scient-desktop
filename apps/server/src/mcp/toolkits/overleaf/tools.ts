import {
  ScientOverleafFilesystemRefusalReason,
  ScientOverleafConflictChoice,
  ScientOverleafCancelResult,
  ScientOverleafConnectionList,
  ScientOverleafKeptCopies,
  ScientOverleafManageResult,
  ScientOverleafPreviewResult,
  ScientOverleafDiffResult,
  ScientOverleafRecoverResult,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
  ScientOverleafUndoableSends,
  ScientOverleafUndoResult,
  SecretRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientOperation, type OperationDefinition } from "../../ScientOperationTool.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { OverleafSync } from "../../../scient/overleaf/OverleafSync.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";

/**
 * Overleaf manual sync for agents: whatever a
 * person can do, with no Overleaf permission, approval or confirmation of its
 * own. Every result carries `lines`, the sentences a person would see, beside
 * the structured fields the app reads. See docs/internals/scient-overleaf-agent-tools.md.
 */

const NonEmptyMessage = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const Lines = Schema.Array(Schema.String).annotate({
  description: "What happened, in the sentences a person sees. Read these first.",
});

export class ScientOverleafToolError extends Schema.TaggedError<ScientOverleafToolError>()(
  "ScientOverleafToolError",
  {
    code: Schema.Literals([
      /** A required input for this action is missing. */
      "invalid-input",
      "project-required",
      "project-changed",
      "workspace-not-authorized",
      "token-missing",
      "token-invalid",
      "secret-unavailable",
      "project-invalid",
      "editor-save-failed",
      "operation-active",
      "connection-not-ready",
      "recovery-required",
      "checkout-busy",
      "limit-reached",
      "state-locked",
      "connection-changed",
      "retention-unavailable",
      "overleaf-unreachable",
      "overleaf-access-denied",
      "overleaf-project-not-found",
      "overleaf-rate-limited",
      "git-unavailable",
      "failed",
    ]),
    message: NonEmptyMessage,
    reason: Schema.optional(ScientOverleafFilesystemRefusalReason),
    /** The files an editor could not save, relative to the linked checkout. */
    paths: Schema.optional(Schema.Array(Schema.String)),
  },
) {}

const dependencies = [
  AgentInvocationContext.AgentInvocationContext,
  WorkspaceBindingResolver,
  OverleafSync,
  SecretRequests,
];

const overleafOperation = (id: string): OperationDefinition => ({
  id,
  scope: "workspace",
  // Overleaf is a document workflow; it adds no grant of its own.
  requiredCapabilities: ["documents:build"],
});

const ConnectionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u)).annotate({
  description: "From scient_overleaf_status.",
});
const Folder = Schema.String.check(Schema.isMaxLength(4_096));
const Choices = Schema.Array(
  Schema.Struct({
    key: Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "A conflict's key from the last result.",
    }),
    choice: ScientOverleafConflictChoice.annotate({
      description:
        "mine keeps this folder's version, theirs takes Overleaf's, markers writes both between conflict marks for you to merge. Use one of the conflict's allowed choices.",
    }),
  }),
)
  .check(Schema.isMaxLength(4_000))
  .annotate({ description: "One choice per conflict." });
const FilePaths = Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(
  Schema.isMaxLength(2_000),
);
const Files = Schema.Struct({
  keepOnlyHere: Schema.optional(FilePaths).annotate({
    description: "New files to keep only here, not sent until you send them.",
  }),
  send: Schema.optional(FilePaths).annotate({
    description:
      "Files to send anyway: skipped new files (build output, hidden, Scient's own) or files kept only here.",
  }),
  release: Schema.optional(FilePaths).annotate({
    description:
      "Files with conflict marks to send as they are, only when the marks are the file's real content. Otherwise merge the marks.",
  }),
}).annotate({
  description:
    "Per-file decisions, paths relative to the linked folder. New files are sent unless the review lists them as skipped.",
});

/** A link with its folder and copy, as every result names it. */
const LinkedCopy = Schema.Struct({
  connectionId: Schema.String,
  checkoutRoot: Schema.String,
  folder: Schema.String,
  /** The caller works in another copy (worktree); the operation acted on this one. */
  linkedElsewhere: Schema.Boolean,
});

const ScientOverleafStatusTool = Tool.make("scient_overleaf_status", {
  description:
    "Show this project's Overleaf links without going online: whether a Git token is saved, and each linked folder's connectionId, Overleaf project, copy and status (edits to send, conflict marks, kept copies, unanswered sends, or a problem and its fix). With connectionId, that link only. Call this first.",
  parameters: Schema.Struct({ connectionId: Schema.optional(ConnectionId) }),
  success: Schema.Struct({
    lines: Lines,
    tokenSaved: Schema.Boolean,
    connections: ScientOverleafConnectionList.fields.connections,
    statuses: Schema.Array(
      Schema.Union([
        ScientOverleafStatus,
        Schema.Struct({ connectionId: Schema.String, error: Schema.String }),
      ]),
    ),
  }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Show Overleaf links")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, overleafOperation("overleaf.status"));

const ScientOverleafPreviewTool = Tool.make("scient_overleaf_preview", {
  description:
    "Show what a sync of one link would bring in from Overleaf and send to it, with any conflicts, without changing Overleaf (like git status and git diff before a push). It fetches from Overleaf. It first settles an interrupted sync, which may write the folder, so it saves the folder's open editors. Pass choices or files to see their effect. Sync with scient_overleaf_sync.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    choices: Schema.optional(Choices),
    files: Schema.optional(Files),
    diff: Schema.optional(Schema.Boolean).annotate({
      description:
        "Include bounded line diffs. Binary and oversized files are listed without contents.",
    }),
  }),
  success: Schema.Struct({
    lines: Lines,
    link: LinkedCopy,
    preview: ScientOverleafPreviewResult,
    diff: Schema.optional(ScientOverleafDiffResult),
  }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Preview an Overleaf sync")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, overleafOperation("overleaf.preview"));

const ScientOverleafConnectTool = Tool.make("scient_overleaf_connect", {
  description:
    "Link an Overleaf project to a folder of this project; everything in that folder syncs. Prefer mode new-folder: it creates `folder`, which must be missing or empty, and the first sync brings the project into it; name it after the paper, such as `paper` or `thesis`. mode link-folder links an existing folder that holds only the paper. Connecting sends nothing and writes no file; the result shows what the first sync would do. Then call scient_overleaf_sync. Needs a saved Overleaf Git token (scient_overleaf_token).",
  parameters: Schema.Struct({
    project: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)).annotate({
      description:
        "The Overleaf project's link (https://www.overleaf.com/project/<id>) or 24-character ID.",
    }),
    mode: Schema.Literals(["new-folder", "link-folder"]),
    folder: Folder.annotate({
      description:
        "Project-relative, with / separators. Empty is the project's top folder: link-folder only, when the whole project is the paper.",
    }),
  }),
  success: Schema.Struct({
    lines: Lines,
    result: ScientOverleafManageResult,
    firstSync: Schema.NullOr(ScientOverleafPreviewResult),
    suggestNewFolder: Schema.Boolean,
  }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link a folder to Overleaf")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, overleafOperation("overleaf.connect"));

const ScientOverleafSyncTool = Tool.make("scient_overleaf_sync", {
  description:
    "Sync one linked folder with Overleaf, like git pull then git push: save its open editors, bring Overleaf's changes in, then send the folder's changes, including new files, deletions and renames. New files that are build output, hidden or Scient's own are skipped unless listed in files.send. At a conflict it applies none of that review's changes and lists each conflict's key and allowed choices: call again with choices and reviewedRemote from that result. A file with conflict marks is not sent until you merge it and remove every mark. Read `lines` and act on them.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    choices: Schema.optional(Choices),
    reviewedRemote: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u)).annotate({
        description: "With choices: the remoteTree of the result that listed the conflicts.",
      }),
    ),
    files: Schema.optional(Files),
  }),
  success: Schema.Struct({ lines: Lines, link: LinkedCopy, result: ScientOverleafSyncResult }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Sync with Overleaf")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, overleafOperation("overleaf.sync"));

const ScientOverleafKeptCopiesTool = Tool.make("scient_overleaf_kept_copies", {
  description:
    "List the copies a sync kept of files it replaced, or restore one: pass applyId, kept, keptRevision and currentRevision exactly as listed. Restoring saves the folder's open editors and keeps the file it replaces as a copy in turn. The next sync sends the restored file.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    restore: Schema.optional(
      Schema.Struct({
        applyId: Schema.String.check(Schema.isMaxLength(64)),
        kept: Schema.String.check(Schema.isMaxLength(256)),
        keptRevision: Schema.String.check(Schema.isMaxLength(100)),
        currentRevision: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
      }),
    ),
  }),
  success: Schema.Struct({
    lines: Lines,
    link: LinkedCopy,
    copies: ScientOverleafKeptCopies.fields.copies,
    restored: Schema.NullOr(
      Schema.Literals([
        "restored",
        /** The restore wrote nothing: list again and retry. */
        "not-restored",
        /** The restore may have stopped partway, or a file changed while it was written. */
        "needs-attention",
        "stale",
        "unknown-copy",
        "duplicate",
      ]),
    ).annotate({
      description:
        "restored only when the copy is back in the folder; not-restored and needs-attention say it is not.",
    }),
  }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Overleaf kept copies")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, overleafOperation("overleaf.kept-copies"));

const ScientOverleafUndoTool = Tool.make("scient_overleaf_undo", {
  description:
    "Undo one send that Overleaf accepted: put back what Overleaf had before it, then sync, so collaborators' earlier text returns (after a deletion or an older version was sent by mistake, say). Without attemptNumber, list the sends that can be undone. With it, save the folder's open editors, put back every file that send changed and keep the replaced files as copies; a file edited since is left as it is and reported. Read `lines` and act on them.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    attemptNumber: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description: "The send to undo, as `send #N` names it. Omit to list the sends.",
      }),
    ),
    files: Schema.optional(Files).annotate({
      description:
        "Per-file decisions for the sync after the undo, as scient_overleaf_sync takes them.",
    }),
  }),
  success: Schema.Struct({
    lines: Lines,
    link: LinkedCopy,
    /** The sends that can be undone; null when this call undid one. */
    sends: Schema.NullOr(ScientOverleafUndoableSends.fields.sends),
    result: Schema.NullOr(ScientOverleafUndoResult),
  }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Undo an Overleaf send")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, overleafOperation("overleaf.undo"));

const ScientOverleafManageTool = Tool.make("scient_overleaf_manage", {
  description:
    "Manage one link. disconnect unlinks the folder; nothing is deleted on either side, and linking the same folder and project again keeps its history. relink records the link's `folder` in this thread's copy of the project, after the folder moved or when status says relink. recover saves the folder's open editors, settles an interrupted sync and checks Overleaf for sends that got no answer. cancel asks a running sync to stop before its next step.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    action: Schema.Literals(["disconnect", "relink", "recover", "cancel"]),
    folder: Schema.optional(Folder).annotate({ description: "For relink: the folder now." }),
  }),
  success: Schema.Struct({
    lines: Lines,
    /** For recover: the copy it ran in (another worktree's link acts on the linked copy). */
    link: Schema.optional(LinkedCopy),
    result: Schema.Union([
      ScientOverleafManageResult,
      Schema.Struct({
        ...ScientOverleafRecoverResult.fields,
        /** How the interrupted apply ended; null when there was none. */
        outcome: Schema.NullOr(Schema.Literals(["complete", "replan", "attention"])),
      }),
      ScientOverleafCancelResult,
    ]),
  }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Manage an Overleaf link")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, overleafOperation("overleaf.manage"));

const ScientOverleafTokenTool = Tool.make("scient_overleaf_token", {
  description:
    "The Overleaf Git token, kept in Scient's secret storage, one per Overleaf site. status says whether one is saved; remove deletes it. To save one, call request_secret (label it Overleaf Git token; the user creates it in Overleaf under Account settings, Git integration), then call this with action save and the returned secretRef. Never ask for the token in chat.",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "save", "remove"]),
    secretRef: Schema.optional(SecretRef).annotate({
      description: "For save: the secretRef from request_secret. It works once.",
    }),
  }),
  success: Schema.Struct({ lines: Lines, saved: Schema.Boolean }),
  failure: ScientOverleafToolError,
  dependencies,
})
  .annotate(Tool.Title, "Overleaf Git token")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, overleafOperation("overleaf.token"));

export const ScientOverleafToolkit = Toolkit.make(
  ScientOverleafStatusTool,
  ScientOverleafPreviewTool,
  ScientOverleafConnectTool,
  ScientOverleafSyncTool,
  ScientOverleafKeptCopiesTool,
  ScientOverleafUndoTool,
  ScientOverleafManageTool,
  ScientOverleafTokenTool,
);
