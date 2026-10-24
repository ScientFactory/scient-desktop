// @effect-diagnostics nodeBuiltinImport:off -- Random request IDs; a bounded look at a linked folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ScientOverleafKeptCopies,
  ScientOverleafManageResult,
  ScientOverleafPreviewResult,
  SecretRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import type { OverleafConnectionRefusal } from "../../../scient/overleaf/OverleafConnections.ts";
import { OverleafEditorSave } from "../../../scient/overleaf/OverleafEditorSave.ts";
import { classifyProbeGitFailure } from "../../../scient/overleaf/OverleafProtocolProbe.ts";
import {
  OverleafSync,
  type OverleafCaller,
  type OverleafSavedFolder,
  type OverleafSyncShape,
} from "../../../scient/overleaf/OverleafSync.ts";
import { refusalView, syncView } from "../../../scient/overleaf/http.ts";
import type { ConflictChoice } from "../../../scient/overleaf/syncRules.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import {
  connectionLine,
  linkedElsewhereLine,
  previewLines,
  statusLines,
  syncLines,
} from "./resultLines.ts";
import { ScientOverleafToolError, ScientOverleafToolkit } from "./tools.ts";

type ErrorCode = ConstructorParameters<typeof ScientOverleafToolError>[0]["code"];

const toolError = (code: ErrorCode, message: string, paths?: ReadonlyArray<string>) =>
  new ScientOverleafToolError({ code, message, ...(paths === undefined ? {} : { paths }) });

const LIST_LINKS = "Call scient_overleaf_status to list this project's links.";
const SAVE_TOKEN =
  "Ask the user for one with request_secret (label: Overleaf Git token; they create it in Overleaf under Account settings, Git integration), then call scient_overleaf_token with action save and the returned secretRef.";

type Failure = { readonly _tag: string; readonly message: string };

/** Overleaf or Git failures, whether the service classified them or Git's error did. */
const OVERLEAF_FAILURES = {
  "access-denied": () =>
    toolError(
      "overleaf-access-denied",
      `Overleaf refused the token, or this account has no Git access to the project (Git access needs a paid Overleaf plan, the user's or the project owner's). To replace the token: ${SAVE_TOKEN}`,
    ),
  "project-not-found": () =>
    toolError(
      "overleaf-project-not-found",
      "Overleaf has no such project, or this account cannot see it.",
    ),
  unreachable: () =>
    toolError("overleaf-unreachable", "Overleaf could not be reached. Try again later."),
  "git-unavailable": () =>
    toolError("git-unavailable", "Git 2.39 or newer is needed on this computer."),
  "git-failed": () => toolError("failed", "Git failed while talking to Overleaf. Try again."),
} as const;

/**
 * An engine or service failure as a fixed category with a plain next step.
 * Git's own text, paths outside the project and the token never leave: Git
 * failures are classified, and anything unexpected is logged by tag only.
 */
const toToolError = (error: Failure): Effect.Effect<ScientOverleafToolError> => {
  const field = (name: string) => (error as unknown as Record<string, unknown>)[name];
  switch (error._tag) {
    case "ScientOverleafToolError":
      return Effect.succeed(error as ScientOverleafToolError);
    case "OverleafSyncRefusedError":
      switch (field("reason")) {
        case "token-missing":
          return Effect.succeed(toolError("token-missing", `${error.message} ${SAVE_TOKEN}`));
        case "relink-needed":
          return Effect.succeed(
            toolError(
              "relink-needed",
              `${error.message} Use scient_overleaf_manage with action relink and the folder's path.`,
            ),
          );
        case "project-invalid":
          return Effect.succeed(
            toolError(
              "project-invalid",
              `${error.message} Use the project's link (https://www.overleaf.com/project/<id>) or its 24-character ID.`,
            ),
          );
        case "folder-changed":
          return Effect.succeed(toolError("connection-changed", `${error.message} ${LIST_LINKS}`));
        case "access-denied":
        case "project-not-found":
        case "unreachable":
        case "git-unavailable":
        case "git-failed":
          return Effect.succeed(
            OVERLEAF_FAILURES[field("reason") as keyof typeof OVERLEAF_FAILURES](),
          );
        default:
          return Effect.succeed(
            toolError("workspace-not-authorized", `${error.message} ${LIST_LINKS}`),
          );
      }
    case "OverleafOperationActiveError":
      return Effect.succeed(
        toolError("operation-active", `${error.message} Wait for it to finish, then try again.`),
      );
    case "OverleafConnectionNotReadyError":
      return Effect.succeed(
        field("reason") === "recovery-required"
          ? toolError(
              "recovery-required",
              `${error.message} Use scient_overleaf_manage with action recover.`,
            )
          : field("reason") === "authority-changed"
            ? toolError("connection-changed", error.message)
            : toolError("connection-not-ready", `${error.message} ${LIST_LINKS}`),
      );
    case "CheckoutRecoveryRequiredError":
      return Effect.succeed(
        toolError(
          "recovery-required",
          `${error.message} Use scient_overleaf_manage with action recover.`,
        ),
      );
    case "CheckoutSuspendedError":
      return Effect.succeed(toolError("checkout-busy", error.message));
    case "OverleafRetainedLimitError":
      return Effect.succeed(toolError("limit-reached", error.message));
    case "OverleafStateLockedError":
      return Effect.succeed(toolError("state-locked", error.message));
    case "OverleafConnectionStaleError":
      return Effect.succeed(
        toolError("connection-changed", "The link changed while this ran. Try again."),
      );
    case "OverleafConnectionUnavailableError":
      return Effect.succeed(
        toolError("connection-not-ready", "This link's record cannot be read."),
      );
    case "OverleafRetentionUnavailableError":
      return Effect.succeed(toolError("retention-unavailable", error.message));
    case "OverleafGitError": {
      // The service classifies Git failures itself; this is the same reading for any left raw.
      const reason = field("reason");
      if (reason === "git-not-found" || reason === "git-too-old")
        return Effect.succeed(OVERLEAF_FAILURES["git-unavailable"]());
      switch (
        classifyProbeGitFailure(error as Parameters<typeof classifyProbeGitFailure>[0]).category
      ) {
        case "authentication-or-access-denied":
        case "credential-prompt":
          return Effect.succeed(OVERLEAF_FAILURES["access-denied"]());
        case "project-not-found":
          return Effect.succeed(OVERLEAF_FAILURES["project-not-found"]());
        case "timeout":
        case "dns":
        case "tls":
        case "connection":
        case "redirect":
          return Effect.succeed(OVERLEAF_FAILURES.unreachable());
      }
      break;
    }
    case "OverleafStateIoError":
      return Effect.succeed(
        toolError(
          "failed",
          "Scient could not read or write its Overleaf records. Check that the disk is not full, then try again.",
        ),
      );
  }
  return Effect.logWarning("Overleaf tool operation failed", { errorTag: error._tag }).pipe(
    Effect.as(toolError("failed", "The Overleaf operation failed. Try again.")),
  );
};

const mapErrors = <A, E extends Failure, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch((error: E) => Effect.flatMap(toToolError(error), Effect.fail)));

const requestId = () => `agent-${NodeCrypto.randomBytes(12).toString("hex")}`;

const choicesOf = (
  choices: ReadonlyArray<{ readonly key: string; readonly choice: ConflictChoice }> | undefined,
) =>
  choices === undefined
    ? {}
    : { choices: new Map(choices.map((entry) => [entry.key, entry.choice])) };

type FileDecisions = {
  readonly keepOnlyHere?: ReadonlyArray<string> | undefined;
  readonly send?: ReadonlyArray<string> | undefined;
};

/** Per-file decisions as the service takes them; absent when none were given. */
const filesOf = (files: FileDecisions | undefined) =>
  files === undefined ||
  ((files.keepOnlyHere?.length ?? 0) === 0 && (files.send?.length ?? 0) === 0)
    ? {}
    : {
        files: {
          ...(files.keepOnlyHere === undefined ? {} : { keepOnlyHere: files.keepOnlyHere }),
          ...(files.send === undefined ? {} : { send: files.send }),
        },
      };

/** The calling thread, resolved by the service (pr-c-design.md section 6). */
const callerOf = Effect.gen(function* () {
  const invocation = yield* AgentInvocationContext.AgentInvocationContext;
  return {
    _tag: "thread",
    threadId: invocation.threadId,
  } satisfies OverleafCaller as OverleafCaller;
});

interface Link {
  readonly connectionId: string;
  readonly checkoutRoot: string;
  readonly folder: string;
  readonly linkedElsewhere: boolean;
}

/**
 * The link as this project lists it: its checkout and folder, and whether the
 * caller works in another copy. A link the list leaves out fails with the
 * service's own reason (relink, another project, disconnected).
 */
const linkFor = Effect.fn("ScientOverleafToolkit.linkFor")(function* (
  overleaf: OverleafSyncShape,
  caller: OverleafCaller,
  connectionId: string,
) {
  const listed = (yield* mapErrors(overleaf.list(caller))).find(
    (connection) => connection.connectionId === connectionId,
  );
  if (listed !== undefined)
    return {
      connectionId,
      checkoutRoot: listed.checkoutRoot,
      folder: listed.folder,
      linkedElsewhere: !listed.linkedHere,
    } satisfies Link;
  const status = yield* mapErrors(overleaf.status({ caller, connectionId }));
  return yield* toolError(
    "connection-not-ready",
    status.availability === "disconnected"
      ? "This link was disconnected. Connect the folder to the same project again to keep its history."
      : `This link is not active in this project. ${LIST_LINKS}`,
  );
});

/**
 * Saves the link's folder in every open window before anything reads it. Any
 * outcome but `saved` stops the operation before it changes a file.
 */
const saveEditors = Effect.fn("ScientOverleafToolkit.saveEditors")(function* (
  link: Link,
  nothing: string,
) {
  const saver = yield* OverleafEditorSave;
  const saved = yield* saver.saveFolder({ checkoutRoot: link.checkoutRoot, folder: link.folder });
  switch (saved._tag) {
    case "saved":
      return;
    case "failed": {
      const files = saved.failures
        .slice(0, 12)
        .map((failure) => `${failure.path} (${failure.reason})`);
      const windows = saved.unanswered
        .slice(0, 12)
        .map((window) => `window ${window.window} (${window.reason})`);
      const what = [
        ...(files.length === 0 ? [] : [`could not save ${files.join(", ")}`]),
        ...(windows.length === 0 ? [] : [`did not answer: ${windows.join(", ")}`]),
      ].join("; ");
      return yield* toolError(
        "editor-save-failed",
        `Open editors were not all saved: ${what}. ${nothing} Fix that editor (for example finish or convert its input) or the window, then try again.`,
        saved.failures.map((failure) => failure.path),
      );
    }
    case "unavailable":
      return yield* toolError(
        "editor-save-failed",
        `Scient cannot ask its windows to save open editors yet. ${nothing}`,
      );
  }
});

const folderChanged = (error: Failure) =>
  error._tag === "OverleafSyncRefusedError" &&
  (error as unknown as { readonly reason?: unknown }).reason === "folder-changed";

/**
 * Saves the link's folder, then runs an operation that may write it (sync, restore,
 * and any prepare or recover that can finish an interrupted apply), naming the saved
 * folder so the service refuses if a relink moved the link meanwhile. Then the new
 * folder is saved and the operation tried once more; a second move is reported.
 */
const afterSavingEditors = Effect.fn("ScientOverleafToolkit.afterSavingEditors")(function* <
  A,
  E extends Failure,
>(
  overleaf: OverleafSyncShape,
  caller: OverleafCaller,
  connectionId: string,
  nothing: string,
  run: (savedFolder: OverleafSavedFolder) => Effect.Effect<A, E>,
) {
  for (let attempt = 0; ; attempt++) {
    const link = yield* linkFor(overleaf, caller, connectionId);
    yield* saveEditors(link, nothing);
    const outcome = yield* run({ checkoutRoot: link.checkoutRoot, folder: link.folder }).pipe(
      Effect.map((value) => ({ moved: false as const, value })),
      Effect.catchIf(folderChanged, () => Effect.succeed({ moved: true as const })),
      Effect.catch((error: E) => Effect.flatMap(toToolError(error), Effect.fail)),
    );
    if (!outcome.moved) return { link, value: outcome.value };
    if (attempt >= 1)
      return yield* toolError(
        "connection-changed",
        `The link moved to another folder twice while open editors were being saved. ${nothing} Call scient_overleaf_status, then try again.`,
      );
  }
});

const withLinkLine = (link: Link, lines: ReadonlyArray<string>) =>
  link.linkedElsewhere ? [linkedElsewhereLine(link.checkoutRoot), ...lines] : [...lines];

const previewView = (
  result: Effect.Success<ReturnType<OverleafSyncShape["preview"]>>,
): ScientOverleafPreviewResult => {
  switch (result._tag) {
    case "review":
      return result;
    case "refused":
      return { _tag: "refused", refusal: refusalView(result.refusal) };
    case "recovered":
      return { _tag: "recovered" };
  }
};

const MANAGE_REFUSALS: Record<OverleafConnectionRefusal, string> = {
  "folder-invalid": "That is not a folder name Scient can link.",
  "folder-missing": "That folder, or the folder it goes in, does not exist.",
  "folder-not-empty":
    "That folder already has files. Use mode link-folder to link it, or choose a new folder name.",
  "folder-outside-checkout": "The folder must be a real folder inside this project, not a link.",
  "folder-overlaps":
    "That folder is linked already, or is inside or around a linked folder. Each Overleaf project needs its own folder.",
  "project-already-linked":
    "This Overleaf project is already linked to another folder of this project.",
  "access-denied": OVERLEAF_FAILURES["access-denied"]().message,
  "project-not-found": OVERLEAF_FAILURES["project-not-found"]().message,
  unreachable: OVERLEAF_FAILURES.unreachable().message,
  "no-branch": "The Overleaf project has no single main or master branch.",
  "git-unavailable": "Git 2.39 or newer is needed on this computer.",
  "git-failed": "Git failed. Try again.",
  "local-work-pending":
    "An interrupted sync is not settled yet. Use scient_overleaf_manage with action recover first.",
  "authority-changed": "This project's workspace changed while the request ran. Try again.",
  "request-incomplete":
    "An earlier request like this one started and never finished, so it is not run again. Try again.",
  "records-unreadable":
    "A link record of this project cannot be read, so which folders are linked is unknown. Nothing was linked or moved; tell the user.",
  "project-invalid":
    "That is not an Overleaf project link or ID. Use the project's link (https://www.overleaf.com/project/<id>) or its 24-character ID.",
};

const manageRefusalLine = (reason: string) =>
  `Nothing changed: ${MANAGE_REFUSALS[reason as OverleafConnectionRefusal] ?? reason}`;

/** File kinds that suggest a folder holds more than a paper (pr-c-design.md section 3). */
const CODE_OR_DATA =
  /\.(?:py|ipynb|m|mat|r|rmd|jl|js|ts|tsx|jsx|c|cc|cpp|h|hpp|rs|go|java|sh|csv|tsv|parquet|h5|hdf5|npy|npz|pkl|feather|nc|sqlite|db|json|ya?ml|toml)$/iu;
const SUGGEST_AT = 5;
/** Entries one look examines; a folder past it is more than a paper anyway. */
const LOOK_LIMIT = 2_000;

/**
 * Code or data files in a folder, outside hidden folders, from a bounded walk
 * that never follows links. Whether the first sync would send them depends on
 * the new-file rule; the folder holds them either way.
 */
const codeOrDataIn = (folder: string) =>
  Effect.promise(async () => {
    let count = 0;
    let seen = 0;
    const pending = [folder];
    while (pending.length > 0 && seen < LOOK_LIMIT) {
      const directory = pending.pop()!;
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++seen > LOOK_LIMIT) break;
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) pending.push(NodePath.join(directory, entry.name));
        else if (entry.isFile() && CODE_OR_DATA.test(entry.name)) count++;
      }
    }
    return count;
  });

export const overleafStatusForInvocation = Effect.fn("ScientOverleafToolkit.status")(
  function* (input: { readonly connectionId?: string | undefined }) {
    const overleaf = yield* OverleafSync;
    const caller = yield* callerOf;
    const tokenSaved = (yield* overleaf.tokenStatus).saved;
    const listed = yield* mapErrors(overleaf.list(caller));
    const connections =
      input.connectionId === undefined
        ? listed
        : listed.filter((connection) => connection.connectionId === input.connectionId);
    const ids =
      input.connectionId === undefined
        ? listed.map((connection) => connection.connectionId)
        : [input.connectionId];
    const lines = [
      tokenSaved
        ? "An Overleaf Git token is saved."
        : `No Overleaf Git token is saved; connecting and syncing need one. ${SAVE_TOKEN}`,
    ];
    if (ids.length === 0)
      lines.push(
        "No folder of this project is linked to Overleaf. Link one with scient_overleaf_connect.",
      );
    const statuses = [];
    for (const connectionId of ids) {
      const found = yield* overleaf.status({ caller, connectionId }).pipe(
        Effect.catch((error) =>
          input.connectionId === undefined
            ? Effect.map(toToolError(error), (mapped) => ({
                connectionId,
                error: mapped.message,
              }))
            : Effect.flatMap(toToolError(error), Effect.fail),
        ),
      );
      statuses.push(found);
      if ("error" in found) {
        const summary = listed.find((connection) => connection.connectionId === connectionId);
        lines.push(
          ...(summary === undefined ? [] : [connectionLine(summary)]),
          `Its status could not be read: ${found.error}`,
        );
      } else lines.push(...statusLines(found));
    }
    return { lines, tokenSaved, connections, statuses };
  },
);

export const overleafPreviewForInvocation = Effect.fn("ScientOverleafToolkit.preview")(
  function* (input: {
    readonly connectionId: string;
    readonly choices?:
      | ReadonlyArray<{ readonly key: string; readonly choice: ConflictChoice }>
      | undefined;
    readonly files?: FileDecisions | undefined;
  }) {
    const overleaf = yield* OverleafSync;
    const caller = yield* callerOf;
    // Preparing may finish an interrupted sync, which writes the folder: editors first.
    const { link, value: result } = yield* afterSavingEditors(
      overleaf,
      caller,
      input.connectionId,
      "Nothing was previewed or changed.",
      (savedFolder) => {
        const request = {
          caller,
          connectionId: input.connectionId,
          ...choicesOf(input.choices),
          ...filesOf(input.files),
          savedFolder,
        };
        return Effect.flatMap(overleaf.preview(request), (first) =>
          // An interrupted sync was finished first; the preview is of what is there now.
          first._tag === "recovered" ? overleaf.preview(request) : Effect.succeed(first),
        );
      },
    );
    const preview = previewView(result);
    return { lines: withLinkLine(link, previewLines(preview)), link, preview };
  },
);

export const overleafConnectForInvocation = Effect.fn("ScientOverleafToolkit.connect")(
  function* (input: {
    readonly project: string;
    readonly mode: "new-folder" | "link-folder";
    readonly folder: string;
  }) {
    const overleaf = yield* OverleafSync;
    const caller = yield* callerOf;
    const connected = yield* mapErrors(
      overleaf.connect({
        caller,
        folder: input.folder,
        create: input.mode === "new-folder",
        project: input.project,
        requestId: requestId(),
      }),
    );
    if (connected._tag === "refused")
      return {
        lines: [manageRefusalLine(connected.reason)],
        result: connected satisfies ScientOverleafManageResult,
        firstSync: null,
        suggestNewFolder: false,
      };
    const connectionId = connected.connection.connectionId;
    const lines = [
      connectionLine(connected.connection),
      connected.reconnected
        ? "Reconnected: this folder's earlier link to the same project was restored with its history."
        : "Connected. No file was changed and nothing was sent yet.",
    ];
    // What the first sync would do. A preview that cannot run leaves the link in place.
    const firstSync = yield* afterSavingEditors(
      overleaf,
      caller,
      connectionId,
      "The first sync was not previewed.",
      (savedFolder) => overleaf.preview({ caller, connectionId, savedFolder }),
    ).pipe(
      Effect.map(({ value }) => previewView(value)),
      Effect.catch((error) =>
        Effect.map(toToolError(error), (mapped) => {
          lines.push(`The first sync could not be previewed: ${mapped.message}`);
          return null;
        }),
      ),
    );
    let suggestNewFolder = false;
    if (firstSync !== null) {
      lines.push("The first sync:", ...previewLines(firstSync));
    }
    // Information, not a step: the agent decides (pr-c-design.md section 3).
    if (input.mode === "link-folder") {
      const count = yield* codeOrDataIn(
        NodePath.join(connected.connection.checkoutRoot, connected.connection.folder),
      );
      if (count >= SUGGEST_AT || (input.folder === "" && count > 0)) {
        suggestNewFolder = true;
        lines.push(
          `This folder looks like more than a paper: it holds ${count === 1 ? "1 code or data file" : `${count} code or data files`}, and everything in a linked folder syncs. Consider disconnecting it and bringing the Overleaf project in as a new folder instead; analysis can write figures into that folder.`,
        );
      }
    }
    lines.push(`Sync with scient_overleaf_sync and connectionId ${connectionId}.`);
    return {
      lines,
      result: {
        _tag: "done" as const,
        connection: connected.connection,
        reconnected: connected.reconnected,
      },
      firstSync,
      suggestNewFolder,
    };
  },
);

export const overleafSyncForInvocation = Effect.fn("ScientOverleafToolkit.sync")(function* (input: {
  readonly connectionId: string;
  readonly choices?:
    | ReadonlyArray<{ readonly key: string; readonly choice: ConflictChoice }>
    | undefined;
  readonly reviewedRemote?: string | undefined;
  readonly files?: FileDecisions | undefined;
}) {
  const overleaf = yield* OverleafSync;
  const caller = yield* callerOf;
  const { link, value: outcome } = yield* afterSavingEditors(
    overleaf,
    caller,
    input.connectionId,
    "Nothing was synced.",
    (savedFolder) =>
      overleaf.sync({
        caller,
        connectionId: input.connectionId,
        requestId: requestId(),
        ...choicesOf(input.choices),
        ...(input.reviewedRemote === undefined ? {} : { reviewedRemote: input.reviewedRemote }),
        ...filesOf(input.files),
        savedFolder,
      }),
  );
  const result = syncView(outcome);
  // Choices answer conflicts as they stood; when Overleaf moved, they were not applied.
  const askedAgain =
    result._tag === "needs-decision" &&
    (input.choices?.length ?? 0) > 0 &&
    input.reviewedRemote !== undefined &&
    result.review.remoteTree !== input.reviewedRemote;
  const lines = syncLines(result);
  return {
    lines: withLinkLine(
      link,
      askedAgain
        ? [
            "Overleaf changed since the review your choices answered, so they were not applied. Decide again for the conflicts below.",
            ...lines,
          ]
        : lines,
    ),
    link,
    result,
  };
});

type KeptCopy = ScientOverleafKeptCopies["copies"][number];

const keptCopyLine = (copy: KeptCopy) =>
  `- ${copy.relativePath}, kept ${copy.retainedAt} (applyId ${copy.applyId}, kept ${copy.kept})${copy.unread ? "; it could not be read, so it cannot be restored from this listing" : copy.keptRevision !== null && copy.keptRevision === copy.currentRevision ? "; the same as the file now" : ""}.`;

export const overleafKeptCopiesForInvocation = Effect.fn("ScientOverleafToolkit.keptCopies")(
  function* (input: {
    readonly connectionId: string;
    readonly restore?:
      | {
          readonly applyId: string;
          readonly kept: string;
          readonly keptRevision: string;
          readonly currentRevision: string | null;
        }
      | undefined;
  }) {
    const overleaf = yield* OverleafSync;
    const caller = yield* callerOf;
    const link = yield* linkFor(overleaf, caller, input.connectionId);
    const lines: string[] = [];
    let restored: "restored" | "stale" | "unknown-copy" | "duplicate" | null = null;
    if (input.restore !== undefined) {
      const restore = input.restore;
      const before = yield* mapErrors(
        overleaf.keptCopies({ caller, connectionId: link.connectionId }),
      );
      const path =
        before.find((copy) => copy.applyId === restore.applyId && copy.kept === restore.kept)
          ?.relativePath ?? "the file";
      const { value: result } = yield* afterSavingEditors(
        overleaf,
        caller,
        link.connectionId,
        "Nothing was restored.",
        (savedFolder) =>
          overleaf.restoreKept({
            caller,
            connectionId: link.connectionId,
            requestId: requestId(),
            ...restore,
            savedFolder,
          }),
      );
      restored = result._tag;
      lines.push(
        result._tag === "restored"
          ? `Restored ${path} from its kept copy; the version it replaced is kept as a copy. Sync to send it to Overleaf.`
          : result._tag === "stale"
            ? "Nothing was restored: the copy or the file changed since the listing. List again and retry with the new revisions."
            : result._tag === "unknown-copy"
              ? "Nothing was restored: no kept copy matches. List again."
              : "This restore already ran; nothing ran again.",
      );
    }
    const copies = yield* mapErrors(
      overleaf.keptCopies({ caller, connectionId: link.connectionId }),
    );
    lines.push(
      copies.length === 0
        ? "No kept copies."
        : `${copies.length} kept ${copies.length === 1 ? "copy" : "copies"}:`,
      ...copies.map(keptCopyLine),
    );
    return { lines: withLinkLine(link, lines), link, copies, restored };
  },
);

export const overleafManageForInvocation = Effect.fn("ScientOverleafToolkit.manage")(
  function* (input: {
    readonly connectionId: string;
    readonly action: "disconnect" | "relink" | "recover" | "cancel";
    readonly folder?: string | undefined;
  }) {
    const overleaf = yield* OverleafSync;
    const caller = yield* callerOf;
    const connectionId = input.connectionId;
    switch (input.action) {
      case "disconnect": {
        const result = yield* mapErrors(
          overleaf.disconnect({ caller, connectionId, requestId: requestId() }),
        );
        return {
          lines: [
            result._tag === "done"
              ? `Disconnected ${result.connection.folder === "" ? "the project's top folder" : `${result.connection.folder}/`} from Overleaf. Nothing was deleted on either side; connecting the same folder to the same project again keeps its history.`
              : manageRefusalLine(result.reason),
          ],
          result,
        };
      }
      case "relink": {
        if (input.folder === undefined)
          return yield* toolError(
            "invalid-input",
            "relink needs folder: the link's folder as it is now, relative to the project.",
          );
        const result = yield* mapErrors(
          overleaf.relink({ caller, connectionId, folder: input.folder, requestId: requestId() }),
        );
        return {
          lines: [
            result._tag === "done"
              ? `Relinked: ${connectionLine(result.connection)}`
              : manageRefusalLine(result.reason),
          ],
          result,
        };
      }
      case "recover": {
        // Recovery finishes an interrupted apply, which writes the folder: editors first.
        const { value: recovered } = yield* afterSavingEditors(
          overleaf,
          caller,
          connectionId,
          "Nothing was recovered.",
          (savedFolder) => overleaf.recover({ caller, connectionId, savedFolder }),
        );
        const result = {
          recovered: recovered._tag === "recovered",
          accepted: recovered.attempts?.accepted ?? null,
          unresolved: recovered.attempts?.unresolved ?? null,
        };
        const lines = [
          result.recovered
            ? "Finished an interrupted sync in the folder."
            : "No interrupted sync to finish.",
        ];
        if (result.accepted === null)
          lines.push("Overleaf could not be reached to check earlier sends.");
        else {
          if (result.accepted.length > 0)
            lines.push(
              `Earlier sends ${result.accepted.map((n) => `#${n}`).join(", ")} arrived on Overleaf.`,
            );
          if ((result.unresolved?.length ?? 0) > 0)
            lines.push(
              `Sends ${result.unresolved!.map((n) => `#${n}`).join(", ")} still have no answer; Scient never sends them again.`,
            );
        }
        return { lines, result };
      }
      case "cancel": {
        const result = yield* mapErrors(overleaf.cancel({ caller, connectionId }));
        return {
          lines: [
            result._tag === "requested"
              ? "Asked this link's running sync to stop before its next step. A step already applying or sending finishes, and its result stands."
              : "No sync is running for this link.",
          ],
          result,
        };
      }
    }
  },
);

export const overleafTokenForInvocation = Effect.fn("ScientOverleafToolkit.token")(
  function* (input: {
    readonly action: "status" | "save" | "remove";
    readonly secretRef?: SecretRef | undefined;
  }) {
    const overleaf = yield* OverleafSync;
    switch (input.action) {
      case "status": {
        const { saved } = yield* overleaf.tokenStatus;
        return {
          lines: [
            saved
              ? "An Overleaf Git token is saved."
              : `No Overleaf Git token is saved. ${SAVE_TOKEN}`,
          ],
          saved,
        };
      }
      case "save": {
        if (input.secretRef === undefined)
          return yield* toolError("invalid-input", `save needs secretRef. ${SAVE_TOKEN}`);
        // The secret was entered for this project; the ref is consumed, and its value
        // goes only to the secret store. It is never returned, logged or put in an error.
        const workspace = yield* consumeAgentWorkspace().pipe(
          Effect.mapError((error) => toolError(error.code, error.message)),
        );
        const secrets = yield* SecretRequests;
        const token = yield* secrets
          .consume({ ref: input.secretRef, projectId: workspace.binding.hostProjectId })
          .pipe(Effect.mapError((error) => toolError("secret-unavailable", error.message)));
        yield* overleaf
          .saveToken(token)
          .pipe(
            Effect.catch((error) =>
              error._tag === "OverleafSyncRefusedError"
                ? Effect.fail(
                    toolError(
                      "token-invalid",
                      `That is not an Overleaf Git token: it is empty, has spaces or is too long. ${SAVE_TOKEN}`,
                    ),
                  )
                : Effect.flatMap(toToolError(error), Effect.fail),
            ),
          );
        return {
          lines: [
            "Saved the Overleaf Git token in Scient's secret storage. A preview built before it is out of date.",
          ],
          saved: true,
        };
      }
      case "remove": {
        yield* mapErrors(overleaf.removeToken);
        return {
          lines: ["Removed the saved Overleaf Git token. Connecting and syncing need a new one."],
          saved: false,
        };
      }
    }
  },
);

const handlers = {
  scient_overleaf_status: (input) => overleafStatusForInvocation(input),
  scient_overleaf_preview: (input) => overleafPreviewForInvocation(input),
  scient_overleaf_connect: (input) => overleafConnectForInvocation(input),
  scient_overleaf_sync: (input) => overleafSyncForInvocation(input),
  scient_overleaf_kept_copies: (input) => overleafKeptCopiesForInvocation(input),
  scient_overleaf_manage: (input) => overleafManageForInvocation(input),
  scient_overleaf_token: (input) => overleafTokenForInvocation(input),
} satisfies Parameters<typeof ScientOverleafToolkit.toLayer>[0];

export const ScientOverleafToolkitHandlersLive = ScientOverleafToolkit.toLayer(handlers);
