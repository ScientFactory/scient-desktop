import {
  ScientOverleafConflictChoice,
  ScientOverleafCancelResult,
  ScientOverleafConnectionList,
  ScientOverleafKeptCopies,
  ScientOverleafManageResult,
  ScientOverleafPreviewResult,
  ScientOverleafRecoverResult,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
  SecretRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ScientOperation, type OperationMetadata } from "../../ScientOperationTool.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { OverleafEditorSave } from "../../../scient/overleaf/OverleafEditorSave.ts";
import { OverleafSync } from "../../../scient/overleaf/OverleafSync.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";

/**
 * Overleaf manual sync for agents (pr-c-design.md sections 1 and 6): whatever a
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
      /** No active link with that ID in the thread's project. */
      "not-linked",
      "workspace-not-authorized",
      "relink-needed",
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
      "git-unavailable",
      "failed",
    ]),
    message: NonEmptyMessage,
    /** The files an editor could not save, relative to the linked checkout. */
    paths: Schema.optional(Schema.Array(Schema.String)),
  },
) {}

const dependencies = [
  AgentInvocationContext.AgentInvocationContext,
  WorkspaceBindingResolver,
  OverleafSync,
  OverleafEditorSave,
  SecretRequests,
];

const overleafOperation = (id: string): OperationMetadata => ({
  id,
  family: "overleaf",
  scope: "workspace",
  // Overleaf is a document workflow; it adds no grant of its own (pr-c-design.md section 1).
  requiredCapabilities: ["documents:build"],
  approval: "session-grant",
  documentation: "docs/internals/scient-overleaf-agent-tools.md",
});

const ConnectionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u)).annotate({
  description: "A link's connectionId, as scient_overleaf_status lists it.",
});
const Folder = Schema.String.check(Schema.isMaxLength(4_096));
const Choices = Schema.Array(
  Schema.Struct({
    key: Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "A conflict's key from the last preview or sync result.",
    }),
    choice: ScientOverleafConflictChoice.annotate({
      description:
        "mine keeps this computer's version, theirs takes Overleaf's, markers writes both into the file between conflict marks for you to merge. Use one of the conflict's allowed choices.",
    }),
  }),
)
  .check(Schema.isMaxLength(4_000))
  .annotate({ description: "One choice per conflict to settle." });
const FilePaths = Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(
  Schema.isMaxLength(2_000),
);
const Files = Schema.Struct({
  keepOnlyHere: Schema.optional(FilePaths).annotate({
    description:
      "New files to keep only on this computer: not sent, and remembered until you send them.",
  }),
  send: Schema.optional(FilePaths).annotate({
    description:
      "Files to send anyway: new files the rule skips (build output, hidden files, Scient's own files) or files kept only on this computer.",
  }),
}).annotate({
  description:
    "Per-file decisions, paths relative to the linked folder. New files are sent by default; the review's additions say which are skipped and why.",
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
    "Show this project's Overleaf links without going online. Without connectionId: whether an Overleaf Git token is saved, and every linked folder with its connectionId, Overleaf project, which copy of the project it belongs to, and its status. With connectionId: that link's status only. Status says whether the folder has edits to send, files with conflict marks, kept copies, unanswered sends, or a problem and what fixes it. Call this first to find a connectionId.",
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
    "Show what a sync of one link would bring in from Overleaf and send to it, with any conflicts, changing nothing on Overleaf (like git status and git diff before a push). It fetches from Overleaf. If an earlier sync was interrupted, it finishes that first, so it saves the folder's open editors before anything else, and stops if one cannot be saved. Pass choices to see the result of settling conflicts, and files to see a per-file decision. Sync with scient_overleaf_sync.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    choices: Schema.optional(Choices),
    files: Schema.optional(Files),
  }),
  success: Schema.Struct({ lines: Lines, link: LinkedCopy, preview: ScientOverleafPreviewResult }),
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
    "Link an Overleaf project to a folder of this project. One Overleaf project lives in its own folder, and everything in that folder syncs. mode new-folder (the default choice) creates `folder`, which must not exist or be empty, and brings the project into it at the first sync; name it after the paper, for example `paper` or `thesis`. mode link-folder links an existing folder that holds just the paper. project is the Overleaf project's link or its 24-character ID. Connecting changes no file and sends nothing; the result shows what the first sync would bring in and send, and says when the folder looks like more than a paper (then prefer a new folder). Then call scient_overleaf_sync. Needs a saved Overleaf Git token (scient_overleaf_token).",
  parameters: Schema.Struct({
    project: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)).annotate({
      description: "The Overleaf project's link (https://www.overleaf.com/project/<id>) or ID.",
    }),
    mode: Schema.Literals(["new-folder", "link-folder"]),
    folder: Folder.annotate({
      description:
        "Project-relative folder with / separators. Empty links the project's top folder (link-folder only, and only when the whole project is the paper).",
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
    "Sync one linked folder with Overleaf: save the folder's open editors, bring Overleaf's changes in, then send the folder's changes (like git pull then git push). New files, deletions, renames and older versions are all synced, then reported; new files that are build output, hidden or Scient's own are skipped unless sent with files.send, and files.keepOnlyHere keeps a new file only on this computer. Only a conflict stops it: then nothing was applied, and the result lists each conflict's key and allowed choices; call again with choices and reviewedRemote from that result. If Overleaf changed since, the choices don't answer the new review and the result asks again. For choice markers, edit each marked file to merge the two versions, remove every conflict mark, then sync again; a file with marks is not sent. If the thread works in another worktree, this syncs the linked copy and says so. Read `lines` and act on them.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    choices: Schema.optional(Choices),
    reviewedRemote: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u)).annotate({
        description:
          "With choices: the review's remoteTree that the choices answer, from the result that listed the conflicts.",
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
    "List the copies a sync kept of files it replaced, or restore one. Without restore: each copy's path, when it was kept, and its revisions. With restore: save the folder's open editors, then put that copy back in the folder; the file it replaces is kept as a copy in turn. Pass applyId, kept, keptRevision and currentRevision exactly as the listing gave them. The restored file goes to Overleaf at the next sync.",
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
        /** The file changed here meanwhile: nothing was written. */
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

const ScientOverleafManageTool = Tool.make("scient_overleaf_manage", {
  description:
    "Manage one link. disconnect unlinks the folder from Overleaf; nothing is deleted on either side, and linking the same folder to the same project again keeps its history. relink records the link's folder (`folder`, project-relative) in this thread's copy of the project, after the folder moved or status says relink. recover saves the folder's open editors, then finishes an interrupted sync and checks Overleaf for earlier sends that got no answer. cancel asks this link's running sync to stop before its next step; a step already applying or sending finishes.",
  parameters: Schema.Struct({
    connectionId: ConnectionId,
    action: Schema.Literals(["disconnect", "relink", "recover", "cancel"]),
    folder: Schema.optional(Folder).annotate({ description: "For relink: the folder now." }),
  }),
  success: Schema.Struct({
    lines: Lines,
    result: Schema.Union([
      ScientOverleafManageResult,
      ScientOverleafRecoverResult,
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
    "The Overleaf Git token, which Scient keeps in its secret storage, one per Overleaf site. status says whether one is saved. To save one: call request_secret (label it Overleaf Git token, and say the user creates it in Overleaf under Account settings, Git integration), then call this with action save and the returned secretRef. Never ask for the token in chat. remove deletes the saved token.",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "save", "remove"]),
    secretRef: Schema.optional(SecretRef).annotate({
      description: "For save: the secretRef request_secret returned. It is consumed.",
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
  ScientOverleafManageTool,
  ScientOverleafTokenTool,
);
