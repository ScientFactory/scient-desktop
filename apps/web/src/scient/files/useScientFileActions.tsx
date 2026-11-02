// SCIENT-OWNED: the Files panel's file management, as in Finder or Explorer:
// new files and folders, rename in place, cut/copy/paste, duplicate, drag to
// move (⌥ to copy), adding items from elsewhere (drop or picker), Open With,
// Move to Trash, and undo of each.
import { useAtomValue } from "@effect/atom-react";
import {
  FILE_TREE_TAG_NAME,
  type FileTree,
  type FileTreeDropContext,
  type FileTreeRenameEvent,
} from "@pierre/trees";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectDirectoryEntry,
  type WorkspaceEntryChange,
  type WorkspaceEntryChangeOutcome,
  type WorkspaceEntryCollision,
  WorkspaceEntryChangeError,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import {
  use,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { folderDropTarget } from "~/components/chat/folderDrop";
import { refreshProjectEntriesQuery } from "~/components/files/projectFilesQueryState";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { connectionAtomRuntime } from "~/connection/runtime";
import { FileMetadataThreadContext } from "~/hooks/FileMetadataThreadProvider";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { windowEditors } from "~/scient/editorFlush/EditorFlushHosts";
import { flushFolderEditors } from "~/scient/editorFlush/flushFolderEditors";
import { applyScientFileRename } from "~/scient/fileSurfaces/scientDocumentSession";
import { renameInTabHistory } from "~/scient/rightPanel/tabHistory";
import { readPrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { cachedOpenWithApps, openWithChoice, openWithKind, withOpenWithApps } from "./fileOpenWith";
import type { LazyWorkspaceTreeController } from "./LazyWorkspaceTreeController";

const changeEntriesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-files:change-entries",
  tag: WS_METHODS.projectsChangeEntries,
});
const openWithAppsCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-files:open-with-apps",
  tag: WS_METHODS.projectsOpenWithApps,
});
const openWithCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-files:open-with",
  tag: WS_METHODS.projectsOpenWith,
});

const isChangeError = Schema.is(WorkspaceEntryChangeError);

const MENU = {
  newFile: "files:new-file",
  newFolder: "files:new-folder",
  addFiles: "files:add-files",
  addFolder: "files:add-folder",
  cut: "files:cut",
  copy: "files:copy",
  paste: "files:paste",
  duplicate: "files:duplicate",
  rename: "files:rename",
  copyPath: "files:copy-path",
  copyRelativePath: "files:copy-relative-path",
  trash: "files:trash",
} as const;
type MenuChoice = (typeof MENU)[keyof typeof MENU];
const MENU_CHOICES = new Set<string>(Object.values(MENU));

const workspaceKey = (environmentId: EnvironmentId, cwd: string) =>
  JSON.stringify([environmentId, cwd]);

/** What Copy or Cut picked up, for Paste in any Files panel of the same project. */
let fileClipboard: {
  readonly key: string;
  readonly mode: "copy" | "cut";
  readonly paths: readonly string[];
} | null = null;

/** The changes that reverse one step. */
type UndoRecord = ReadonlyArray<WorkspaceEntryChange>;
/** Undo per project, newest last. */
const undoStacks = new Map<string, Array<UndoRecord>>();
const MAX_UNDO = 50;

/** Resolves once the window has focus, or after a second at most. */
const windowFocused = () =>
  new Promise<void>((resolve) => {
    if (document.hasFocus()) return resolve();
    const done = () => {
      window.removeEventListener("focus", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 300);
    window.addEventListener("focus", done);
  });

/**
 * Keys typed between a New File or New Folder choice and its name field taking
 * focus, kept for the field instead of reaching the tree (whose type-to-find
 * would eat them). Ends after a few seconds at most.
 */
function captureEarlyKeys(isField: (target: EventTarget | undefined) => boolean) {
  const typed = { text: "", finish: null as "Enter" | "Escape" | null };
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (isField(event.composedPath()[0]) || typed.finish !== null) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" || event.key === "Escape") typed.finish = event.key;
    else if (event.key === "Backspace") typed.text = typed.text.slice(0, -1);
    else if (event.key.length === 1) typed.text += event.key;
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("keydown", onKey, true);
  };
  const timer = setTimeout(stop, 3_000);
  window.addEventListener("keydown", onKey, true);
  return { typed, stop };
}

/** Puts early keys into the name field as if typed there. */
function replayEarlyKeys(
  field: HTMLInputElement,
  typed: { readonly text: string; readonly finish: "Enter" | "Escape" | null },
) {
  if (typed.text) {
    // The field is controlled: set its value the way typing does, then announce it.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      field,
      typed.text,
    );
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }
  if (typed.finish) {
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: typed.finish,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  }
}

/** Tree paths end with "/" for folders; project paths never do. */
const projectPath = (treePath: string) => treePath.replace(/\/$/u, "");
const parentOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const isUnder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
/** Selected paths without those inside another selected folder. */
const outermost = (paths: readonly string[]) =>
  [...new Set(paths)].filter(
    (path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)),
  );

/** The changes that reverse a finished one, or none when it cannot be undone. */
function undoFor(
  change: WorkspaceEntryChange,
  outcomes: ReadonlyArray<WorkspaceEntryChangeOutcome>,
): ReadonlyArray<WorkspaceEntryChange> | null {
  const restoreIds = outcomes.flatMap((outcome) =>
    outcome.to === undefined && outcome.restoreId ? [outcome.restoreId] : [],
  );
  const restore: WorkspaceEntryChange[] =
    restoreIds.length > 0 ? [{ _tag: "restore", restoreIds }] : [];
  switch (change._tag) {
    case "move": {
      const items = outcomes.flatMap((outcome) =>
        outcome.from !== undefined && outcome.to !== undefined
          ? [{ from: outcome.to, to: outcome.from }]
          : [],
      );
      // Moves go back first, then whatever they replaced comes out of the Trash.
      return [
        ...(items.length > 0 ? [{ _tag: "move", items, collision: "ask" } as const] : []),
        ...restore,
      ];
    }
    case "copy":
    case "import":
    case "create-folder":
    case "create-file": {
      // What was made goes to the Trash; what a copy replaced comes back.
      const created = outcomes.flatMap((outcome) => (outcome.to === undefined ? [] : [outcome.to]));
      return [
        ...(created.length > 0 ? [{ _tag: "trash", relativePaths: created } as const] : []),
        ...restore,
      ];
    }
    case "trash": {
      // Windows' Recycle Bin does not say where things went; nothing to undo with.
      if (outcomes.some((outcome) => outcome.restoreId === undefined)) return null;
      return restore;
    }
    case "restore":
      return null;
  }
}

type ClashChoice = Exclude<WorkspaceEntryCollision, "ask"> | null;

/**
 * File management for one Files tree. The tree model is created after this
 * hook (its options come from here), so it arrives through `attachModel`.
 */
export function useScientFileActions(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** A host folder opened read-only: none of this applies. */
  readonly hostFolder: boolean;
  readonly treeEntries: RefObject<ReadonlyMap<string, ProjectDirectoryEntry>>;
  readonly treeController: RefObject<LazyWorkspaceTreeController | null>;
  /** Selection changes until the end of this task are the tree's own, not a request to open. */
  readonly quietSelection: () => void;
}) {
  const { environmentId, cwd } = input;
  const enabled = !input.hostFolder;
  const key = workspaceKey(environmentId, cwd);
  const modelRef = useRef<FileTree | null>(null);
  const menuTargetsRef = useRef<readonly string[]>([]);
  /** A new file or folder the tree shows while it is being named, before it exists. */
  const pendingCreateRef = useRef<{
    readonly relativePath: string;
    readonly kind: "folder" | "file";
  } | null>(null);
  const copyOnDropRef = useRef(false);
  const runChange = useAtomCommand(changeEntriesCommand, { reportFailure: false });
  const runOpenWithApps = useAtomCommand(openWithAppsCommand, { reportFailure: false });
  const runOpenWith = useAtomCommand(openWithCommand, { reportFailure: false });
  // The apps the open menu listed, for its clicks.
  const menuAppsRef = useRef<{
    readonly path: string;
    readonly offered: Awaited<ReturnType<typeof cachedOpenWithApps>>;
    readonly editorNames: ReadonlySet<string>;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    readonly folder: string;
    readonly allowed: boolean;
  } | null>(null);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const trashLabel = serverConfig?.environment.platform.os === "windows" ? "Recycle Bin" : "Trash";
  // The chat whose tabs follow moved files; a detached window without one leaves them.
  const threadRef = use(FileMetadataThreadContext);
  const [clash, setClash] = useState<{
    readonly paths: readonly string[];
    readonly resolve: (choice: ClashChoice) => void;
  } | null>(null);

  const entryOf = (path: string) => input.treeEntries.current.get(path);
  const writable = (path: string) => path !== "" && entryOf(path)?.readOnly !== true;
  const isFolder = (path: string) => entryOf(path)?.kind === "directory";
  const folderWritable = (folder: string) => folder === "" || writable(folder);
  /** Items from elsewhere are named by paths on this computer, so the server must run here. */
  const canImport = () =>
    window.desktopBridge !== undefined &&
    folderDropTarget({
      localEnvironmentDisabled: isLocalEnvironmentDisabled(),
      environmentId,
      primaryEnvironmentId: readPrimaryEnvironmentId(),
      connection: readPreparedConnection(environmentId),
      isDesktopRenderer: true,
    }) === "local";

  const refresh = () => {
    void input.treeController.current?.refresh();
    refreshProjectEntriesQuery(environmentId, cwd);
  };

  /** Saves this window's open editors under `paths`, so a change carries their latest text. */
  const saveEditorsUnder = async (paths: readonly string[]) => {
    const answer = await flushFolderEditors(environmentId, windowEditors, async (files) =>
      files.map((file) =>
        file.cwd === cwd && paths.some((path) => isUnder(file.relativePath, path))
          ? { status: "inside" as const, path: file.relativePath }
          : { status: "outside" as const },
      ),
    );
    const failure = answer.failures[0];
    if (failure === undefined) return true;
    toastManager.add({
      type: "error",
      title: `Couldn’t save ${baseName(failure.path)} first`,
      description: failure.message,
    });
    return false;
  };

  /** Open tabs of moved files follow them, with their Back and Forward history. */
  const followMoves = (moves: ReadonlyArray<{ readonly from: string; readonly to: string }>) => {
    if (threadRef === null || moves.length === 0) return;
    const surfaces = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    ).surfaces;
    for (const surface of surfaces) {
      if (surface.kind !== "file") continue;
      const move = moves.find((candidate) => isUnder(surface.relativePath, candidate.from));
      if (!move) continue;
      const destination = move.to + surface.relativePath.slice(move.from.length);
      applyScientFileRename({
        environmentId,
        cwd,
        relativePath: surface.relativePath,
        usesDocumentSession: true,
        destinationRelativePath: destination,
        onFileRenamed: (from, to) =>
          renameInTabHistory(threadRef, from, to, () =>
            useRightPanelStore.getState().renameFileSurface(threadRef, from, to),
          ),
      });
    }
  };

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: isChangeError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : "Something went wrong.",
    });
  };

  /**
   * Sends one change; a taken name asks Replace or Keep Both. Returns what
   * changed, or null when nothing did (or the person stopped).
   */
  const perform = async (
    change: WorkspaceEntryChange,
    options: {
      readonly failureTitle: string;
      readonly recordUndo?: boolean;
      /** Receives this change's own undo record, as a toast's Undo needs. */
      readonly onUndoRecord?: (record: UndoRecord) => void;
      /** The caller refreshes the tree itself (to name a new item once it is listed). */
      readonly ownRefresh?: boolean;
    },
  ): Promise<ReadonlyArray<WorkspaceEntryChangeOutcome> | null> => {
    const record = (outcomes: ReadonlyArray<WorkspaceEntryChangeOutcome>) => {
      const undo = settle(change, outcomes, options.recordUndo ?? true, !options.ownRefresh);
      if (undo) options.onUndoRecord?.(undo);
    };
    const result = await runChange({ environmentId, input: { cwd, change } });
    if (result._tag === "Success") {
      record(result.value.entries);
      return result.value.entries;
    }
    const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    const completed = isChangeError(error) ? (error.completed ?? []) : [];
    if (completed.length > 0) record(completed);
    if (
      isChangeError(error) &&
      error.failure === "exists" &&
      (change._tag === "move" || change._tag === "copy" || change._tag === "import") &&
      change.collision === "ask"
    ) {
      // Items already done stay done (and undoable); the choice applies to the rest.
      const done = (from: string) =>
        completed.some((outcome) => outcome.from === from && outcome.to !== undefined);
      const rest: WorkspaceEntryChange | null =
        change._tag === "import"
          ? { ...change, sources: change.sources.filter((source) => !done(source)) }
          : { ...change, items: change.items.filter((item) => !done(item.from)) };
      const remaining = rest._tag === "import" ? rest.sources : "items" in rest ? rest.items : [];
      const choice = await new Promise<ClashChoice>((resolve) =>
        setClash({ paths: error.paths ?? [], resolve }),
      );
      setClash(null);
      if (choice === null || remaining.length === 0) {
        refresh();
        return completed.length > 0 ? completed : null;
      }
      const after = await perform({ ...rest, collision: choice } as WorkspaceEntryChange, options);
      return [...completed, ...(after ?? [])];
    }
    if (completed.length === 0) refresh();
    reportFailure(options.failureTitle, error);
    return null;
  };

  /** Follows the change in tabs and the tree; returns the undo record it kept. */
  const settle = (
    change: WorkspaceEntryChange,
    outcomes: ReadonlyArray<WorkspaceEntryChangeOutcome>,
    recordUndo: boolean,
    refreshTree = true,
  ): UndoRecord | null => {
    followMoves(
      change._tag === "move"
        ? outcomes.flatMap((outcome) =>
            outcome.from !== undefined && outcome.to !== undefined
              ? [{ from: outcome.from, to: outcome.to }]
              : [],
          )
        : [],
    );
    const undo = recordUndo ? undoFor(change, outcomes) : null;
    if (undo && undo.length > 0) {
      const stack = undoStacks.get(key) ?? [];
      stack.push(undo);
      if (stack.length > MAX_UNDO) stack.shift();
      undoStacks.set(key, stack);
    }
    if (refreshTree) refresh();
    return undo && undo.length > 0 ? undo : null;
  };

  /** Undoes one record, if it was not undone already; ⌘Z passes the newest. */
  const runUndo = async (record: UndoRecord | undefined) => {
    const stack = undoStacks.get(key);
    const at = record === undefined || !stack ? -1 : stack.lastIndexOf(record);
    if (at < 0) return;
    stack!.splice(at, 1);
    for (const step of record!) {
      if ((await perform(step, { failureTitle: "Couldn’t undo", recordUndo: false })) === null) {
        return;
      }
    }
  };

  /** The folder a new item or a paste goes into: a selected folder, else the item's own folder. */
  const folderFor = (paths: readonly string[]) => {
    const [first] = paths;
    if (first === undefined) return "";
    return paths.length === 1 && isFolder(first) ? first : parentOf(first);
  };

  const startRenaming = (path: string, folder: boolean) => {
    input.quietSelection();
    modelRef.current?.startRenaming(folder ? `${path}/` : path);
  };

  /**
   * New File and New Folder show a name field at once, as VS Code does: the row
   * is the tree's own until named, and the entry is made on disk with that name.
   */
  const create = async (kind: "folder" | "file", folder: string) => {
    const model = modelRef.current;
    const controller = input.treeController.current;
    if (!model || !controller) return;
    const early = captureEarlyKeys(
      (target) => target instanceof HTMLInputElement && target === nameField(),
    );
    // The folder is listed and open, so the new row sits inside it.
    if (folder) {
      if (!(await controller.ensurePath(folder)) || !(await controller.load(folder))) {
        early.stop();
        return;
      }
      const item = model.getItem(`${folder}/`);
      if (item && "expand" in item) item.expand();
    }
    const [stem, extension] = kind === "folder" ? ["untitled folder", ""] : ["untitled", ".md"];
    let relativePath = join(folder, `${stem}${extension}`);
    for (
      let number = 2;
      model.getItem(relativePath) || model.getItem(`${relativePath}/`);
      number++
    ) {
      relativePath = join(folder, `${stem} ${number}${extension}`);
    }
    const treePath = kind === "folder" ? `${relativePath}/` : relativePath;
    // A native menu gives the window its focus back a moment after it closes;
    // a name field focused before then would not get the typing.
    await windowFocused();
    model.add(treePath);
    pendingCreateRef.current = { relativePath, kind };
    input.quietSelection();
    model.startRenaming(treePath, { removeIfCanceled: true });
    requestAnimationFrame(() => {
      early.stop();
      const field = nameField();
      if (!field) return;
      if ((field.getRootNode() as ShadowRoot).activeElement !== field) {
        field.focus();
        field.select();
      }
      replayEarlyKeys(field, early.typed);
    });
  };

  /** This panel's name field while an entry is being named. */
  const nameField = () => {
    const trees = document.querySelectorAll(
      `[data-file-browser-panel="${CSS.escape(`${environmentId}:${cwd}`)}"] ${FILE_TREE_TAG_NAME}`,
    );
    for (const tree of trees) {
      const field = tree.shadowRoot?.querySelector("input");
      if (field) return field;
    }
    return null;
  };

  /** Makes a named new entry on disk; the server picks a free name if this one is taken. */
  const makeEntry = (relativePath: string, kind: "folder" | "file") => {
    input.treeController.current?.noteAdded(relativePath, kind === "folder" ? "directory" : "file");
    void perform(
      { _tag: kind === "folder" ? "create-folder" : "create-file", relativePath },
      { failureTitle: kind === "folder" ? "Couldn’t make a folder" : "Couldn’t make a file" },
    );
  };

  /**
   * A new entry left with its first name (Return or a click elsewhere without
   * changes) is made with it; one whose naming was cancelled is gone from the tree.
   */
  const finishPendingCreate = () => {
    const pending = pendingCreateRef.current;
    if (!pending) return;
    const { relativePath, kind } = pending;
    const field = nameField();
    if (field && (field.getRootNode() as ShadowRoot).activeElement === field) return;
    pendingCreateRef.current = null;
    const treePath = kind === "folder" ? `${relativePath}/` : relativePath;
    if (modelRef.current?.getItem(treePath)) makeEntry(relativePath, kind);
  };

  const transfer = async (
    mode: "move" | "copy",
    paths: readonly string[],
    folder: string,
  ): Promise<ReadonlyArray<WorkspaceEntryChangeOutcome>> => {
    const sources = outermost(paths).filter(writable);
    if (sources.length === 0) return [];
    // A copy into its own folder is a duplicate; a move there changes nothing.
    const items = sources
      .map((from) => ({ from, to: join(folder, baseName(from)) }))
      .filter((item) => mode === "copy" || item.from !== item.to);
    if (items.length === 0) return [];
    if (!(await saveEditorsUnder(items.map((item) => item.from)))) {
      refresh();
      return [];
    }
    // Pasting a copy into its own folder makes "name copy", as Duplicate does.
    const besideItself = mode === "copy" && items.every((item) => item.from === item.to);
    const done = await perform(
      { _tag: mode, items, collision: besideItself ? "keep-both" : "ask" },
      { failureTitle: mode === "move" ? "Couldn’t move" : "Couldn’t copy" },
    );
    return done ?? [];
  };

  /** Each item is copied beside itself, as "name copy". */
  const duplicate = async (paths: readonly string[]) => {
    const items = outermost(paths)
      .filter(writable)
      .map((from) => ({ from, to: from }));
    if (items.length === 0 || !(await saveEditorsUnder(paths))) return;
    await perform(
      { _tag: "copy", items, collision: "keep-both" },
      { failureTitle: "Couldn’t duplicate" },
    );
  };

  const paste = async (paths: readonly string[]) => {
    const picked = fileClipboard;
    if (picked === null || picked.key !== key) return;
    const done = await transfer(
      picked.mode === "cut" ? "move" : "copy",
      picked.paths,
      folderFor(paths),
    );
    if (picked.mode !== "cut") return;
    // What was cut and did not move (stopped at a taken name, or failed) stays cut.
    const moved = new Set(
      done.flatMap((outcome) => (outcome.to === undefined ? [] : [outcome.from])),
    );
    const left = picked.paths.filter((path) => !moved.has(path));
    fileClipboard = left.length > 0 ? { ...picked, paths: left } : null;
  };

  const moveToTrash = async (paths: readonly string[]) => {
    const targets = outermost(paths).filter(writable);
    if (targets.length === 0) return;
    if (!(await saveEditorsUnder(targets))) return;
    let ownUndo: UndoRecord | undefined;
    const trashed = await perform(
      { _tag: "trash", relativePaths: targets },
      {
        failureTitle: `Couldn’t move to the ${trashLabel}`,
        onUndoRecord: (record) => {
          ownUndo = record;
        },
      },
    );
    if (trashed === null) return;
    const canUndo = trashed.every((outcome) => outcome.restoreId !== undefined);
    const toastId = toastManager.add({
      type: "success",
      // Long enough to reach Undo; ⌘Z in the tree works after it closes.
      timeout: 10_000,
      title:
        trashed.length === 1
          ? `Moved ${baseName(trashed[0]!.from ?? "")} to the ${trashLabel}`
          : `Moved ${trashed.length} items to the ${trashLabel}`,
      ...(canUndo
        ? {
            actionProps: {
              children: "Undo",
              onClick: () => {
                toastManager.close(toastId);
                // This toast's own step, even if other changes came after it.
                void runUndo(ownUndo);
              },
            },
          }
        : {}),
    });
  };

  /** Copies items from elsewhere on this computer into `folder`; the originals stay. */
  const importItems = async (sources: readonly string[], folder: string) => {
    if (sources.length === 0) return;
    await perform(
      { _tag: "import", sources: [...sources], folder, collision: "ask" },
      { failureTitle: "Couldn’t add" },
    );
  };

  /** The paths of dropped or picked files, as this computer names them. */
  const pathsOf = (files: Iterable<File>) =>
    [...files].flatMap((file) => {
      const path = window.desktopBridge?.getPathForFile(file);
      return path ? [path] : [];
    });

  /** The system's file chooser, several files at once. */
  const addFiles = (folder: string) => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.addEventListener("change", () => {
      void importItems(pathsOf(picker.files ?? []), folder);
    });
    picker.click();
  };

  const addFolder = async (folder: string) => {
    const picked = await readLocalApi()?.dialogs.pickFolder({
      targetEnvironmentId: environmentId,
    });
    if (picked) await importItems([picked], folder);
  };

  const copyPaths = async (paths: readonly string[], absolute: boolean) => {
    const text = paths
      .map((path) => (absolute ? resolveWorkspaceFilePath(path, cwd) : path))
      .join("\n");
    try {
      await writeTextToClipboard(text);
    } catch (error) {
      reportFailure("Couldn’t copy the path", error);
    }
  };

  const act = (choice: MenuChoice, paths: readonly string[]) => {
    switch (choice) {
      case MENU.newFile:
        return void create("file", folderFor(paths));
      case MENU.newFolder:
        return void create("folder", folderFor(paths));
      case MENU.addFiles:
        return addFiles(folderFor(paths));
      case MENU.addFolder:
        return void addFolder(folderFor(paths));
      case MENU.cut:
      case MENU.copy: {
        const picked = paths.filter(writable);
        if (picked.length > 0) {
          fileClipboard = { key, mode: choice === MENU.cut ? "cut" : "copy", paths: picked };
        }
        return;
      }
      case MENU.paste:
        return void paste(paths);
      case MENU.duplicate:
        return void duplicate(paths);
      case MENU.rename: {
        const [path] = paths;
        if (path !== undefined) startRenaming(path, isFolder(path));
        return;
      }
      case MENU.copyPath:
        return void copyPaths(paths, true);
      case MENU.copyRelativePath:
        return void copyPaths(paths, false);
      case MENU.trash:
        return void moveToTrash(paths);
    }
  };

  /** The right-clicked item, or the whole selection when it is part of it. */
  const targetsFor = (treePath: string) => {
    const selected = modelRef.current?.getSelectedPaths() ?? [];
    const paths = selected.includes(treePath) ? selected : [treePath];
    return outermost(paths.map(projectPath));
  };

  /** The folder under the pointer: a folder row, a file row's folder, or the project's top. */
  const dropFolderUnder = (event: DragEvent<HTMLElement>) => {
    const row = event.nativeEvent
      .composedPath()
      .find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.hasAttribute("data-item-path"),
      );
    const treePath = row?.getAttribute("data-item-path");
    if (!treePath) return "";
    return treePath.endsWith("/") ? projectPath(treePath) : parentOf(treePath);
  };

  const dropPairs = (context: FileTreeDropContext) => {
    const folder =
      context.target.kind === "root" || context.target.directoryPath === null
        ? ""
        : projectPath(context.target.directoryPath);
    return { folder, paths: outermost(context.draggedPaths.map(projectPath)) };
  };

  const treeOptions = {
    dragAndDrop: {
      canDrag: (paths: readonly string[]) => enabled && paths.map(projectPath).every(writable),
      canDrop: (context: FileTreeDropContext) => {
        if (!enabled) return false;
        const { folder } = dropPairs(context);
        return folder === "" || writable(folder);
      },
      // The tree already shows the move; follow it, then make it on disk.
      onDropComplete: (context: FileTreeDropContext) => {
        const { folder, paths } = dropPairs(context);
        const copy = copyOnDropRef.current;
        for (const path of paths) {
          input.treeController.current?.noteMoved(path, join(folder, baseName(path)));
        }
        void transfer(copy ? "copy" : "move", paths, folder);
      },
      // The tree refuses a drop onto a name it already lists; the disk decides.
      onDropError: (_error: string, context: FileTreeDropContext) => {
        const { folder, paths } = dropPairs(context);
        void transfer(copyOnDropRef.current ? "copy" : "move", paths, folder);
      },
      openOnDropDelay: 600,
    },
    renaming: {
      canRename: (item: { readonly path: string }) => enabled && writable(projectPath(item.path)),
      onRename: (event: FileTreeRenameEvent) => {
        const from = projectPath(event.sourcePath);
        const to = projectPath(event.destinationPath);
        // The tree moves and reselects the row right after this returns.
        input.quietSelection();
        const pending = pendingCreateRef.current;
        if (pending?.relativePath === from) {
          pendingCreateRef.current = null;
          queueMicrotask(() => makeEntry(to, pending.kind));
          return;
        }
        queueMicrotask(() => input.treeController.current?.noteMoved(from, to));
        void (async () => {
          if (!(await saveEditorsUnder([from]))) return refresh();
          await perform(
            { _tag: "move", items: [{ from, to }], collision: "ask" },
            { failureTitle: "Couldn’t rename" },
          );
        })();
      },
      onError: (message: string) =>
        toastManager.add({ type: "error", title: "Couldn’t rename", description: message }),
    },
  };

  /** Shortcuts while the tree has focus, as in Finder (Ctrl on Windows and Linux). */
  const onKeyDown = useStableCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || event.defaultPrevented) return;
    // Only keys pressed in the tree itself, not in the search field or the bar's buttons.
    if (!(event.target instanceof Element) || event.target.closest(FILE_TREE_TAG_NAME) === null) {
      return;
    }
    const origin = event.nativeEvent.composedPath()[0];
    if (
      origin instanceof HTMLInputElement ||
      origin instanceof HTMLTextAreaElement ||
      (origin instanceof HTMLElement && origin.isContentEditable)
    ) {
      return;
    }
    const model = modelRef.current;
    if (!model) return;
    const command = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    const selected = model.getSelectedPaths().map(projectPath);
    const focused = model.getFocusedPath();
    const paths = selected.length > 0 ? outermost(selected) : focused ? [projectPath(focused)] : [];
    const pressed = event.key.toLowerCase();
    let choice: MenuChoice | "undo" | null = null;
    if (command && !event.shiftKey && !event.altKey) {
      if (pressed === "c") choice = MENU.copy;
      else if (pressed === "x") choice = MENU.cut;
      else if (pressed === "v") choice = MENU.paste;
      // ⌘D stays Scient's Diff toggle; Duplicate is in the menu.
      else if (pressed === "z") choice = "undo";
      else if (pressed === "backspace") choice = MENU.trash;
    } else if (command && event.shiftKey && pressed === "n") {
      choice = MENU.newFolder;
    } else if (!command && !event.altKey && pressed === "delete") {
      choice = MENU.trash;
    }
    if (choice === null) return;
    // With no file change to undo, ⌘Z stays the chat's Undo.
    const undoRecord = choice === "undo" ? undoStacks.get(key)?.at(-1) : undefined;
    if (choice === "undo" && undoRecord === undefined) return;
    if (
      choice !== "undo" &&
      choice !== MENU.paste &&
      choice !== MENU.newFolder &&
      paths.length === 0
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (choice === "undo") void runUndo(undoRecord);
    else act(choice, paths);
  });

  const dialog = (
    <AlertDialog
      open={clash !== null}
      onOpenChange={(open) => {
        if (!open) clash?.resolve(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {clash?.paths.length === 1
              ? `“${baseName(clash.paths[0]!)}” already exists here`
              : `${clash?.paths.length ?? 0} items already exist here`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Replace moves what is there now to the {trashLabel}. Keep Both gives the new{" "}
            {clash?.paths.length === 1 ? "item" : "items"} a numbered name.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => clash?.resolve(null)}>
            Stop
          </Button>
          <Button variant="outline" onClick={() => clash?.resolve("keep-both")}>
            Keep Both
          </Button>
          <Button onClick={() => clash?.resolve("replace")}>Replace</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  const attachModel = useStableCallback((model: FileTree) => {
    modelRef.current = model;
  });

  return {
    attachModel,
    treeOptions: enabled ? treeOptions : { dragAndDrop: { canDrop: () => false } },
    /** ⌥ (Alt) held while dropping makes a copy. */
    onDragOver: (event: { readonly altKey: boolean }) => {
      copyOnDropRef.current = event.altKey;
    },
    onKeyDown,
    /** Focus leaving the tree ends a new entry's naming, as a click elsewhere does. */
    onBlur: () => setTimeout(finishPendingCreate, 0),
    /** Return or Escape in a name field: seen before the tree, which keeps the key to itself. */
    onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
      const origin = event.nativeEvent.composedPath()[0];
      if (origin instanceof HTMLInputElement && (event.key === "Enter" || event.key === "Escape"))
        setTimeout(finishPendingCreate, 0);
    },
    /** The right-click menu's file items, in groups the panel places between its own. */
    menuItems: (treePath: string) => {
      if (!enabled) return { create: [], edit: [], trash: [], copiesMention: false };
      const targets = targetsFor(treePath);
      menuTargetsRef.current = targets;
      const single = targets.length === 1;
      // Scient's own records and tool folders stay as they are, even as a copy's source.
      const allWritable = targets.every(writable);
      const folder = folderFor(targets);
      const intoFolder = folderWritable(folder);
      const canPaste = fileClipboard?.key === key && intoFolder;
      // As Finder does, a selection says how many items an action takes.
      const items = single ? "" : ` ${targets.length} Items`;
      const what = single ? (isFolder(targets[0]!) ? "Folder" : "File") : `${targets.length} Items`;
      const create: ContextMenuItem[] = [
        { id: MENU.newFile, label: "New File", separatorBefore: true, disabled: !intoFolder },
        { id: MENU.newFolder, label: "New Folder", disabled: !intoFolder },
        // From elsewhere on this computer, through its own file chooser.
        ...(canImport()
          ? [
              { id: MENU.addFiles, label: "Add Files…", disabled: !intoFolder },
              { id: MENU.addFolder, label: "Add Folder…", disabled: !intoFolder },
            ]
          : []),
      ];
      const edit: ContextMenuItem[] = [
        { id: MENU.cut, label: `Cut${items}`, separatorBefore: true, disabled: !allWritable },
        {
          id: "files:copy-menu",
          label: "Copy",
          children: [
            { id: MENU.copy, label: what, disabled: !allWritable },
            { id: MENU.copyPath, label: "Path" },
            { id: MENU.copyRelativePath, label: "Relative Path" },
            // The panel's own Copy mention, kept under Copy.
            { id: "copy-mention", label: "Mention" },
          ],
        },
        { id: MENU.paste, label: "Paste", disabled: !canPaste },
        { id: MENU.duplicate, label: `Duplicate${items}`, disabled: !allWritable },
        ...(single ? [{ id: MENU.rename, label: "Rename…", disabled: !allWritable }] : []),
      ];
      const trash: ContextMenuItem[] = [
        {
          id: MENU.trash,
          label: single ? `Move to ${trashLabel}` : `Move${items} to ${trashLabel}`,
          destructive: true,
          separatorBefore: true,
          disabled: !allWritable,
        },
      ];
      return { create, edit, trash, copiesMention: true };
    },
    /** The menu's Open With, filled with every app the computer offers for the entry. */
    withOpenWith: async (
      treePath: string,
      items: ReadonlyArray<ContextMenuItem>,
    ): Promise<ContextMenuItem[]> => {
      if (!enabled) return [...items];
      const path = projectPath(treePath);
      const offered = await cachedOpenWithApps(
        openWithKind(environmentId, path, treePath.endsWith("/")),
        // Without the computer's list the menu still opens, with the code editors.
        async () => {
          try {
            const result = await runOpenWithApps({
              environmentId,
              input: { cwd, relativePath: path },
            });
            return result._tag === "Success" ? result.value : null;
          } catch {
            return null;
          }
        },
      );
      const editorNames = new Set(
        (items.find((item) => item.id === "open-with")?.children ?? []).map((item) => item.label),
      );
      menuAppsRef.current = { path, offered, editorNames };
      return withOpenWithApps(items, offered);
    },
    /** Acts on a choice from `menuItems` or Open With; false when it is not one of them. */
    handleMenuChoice: (clicked: string) => {
      const listed = menuAppsRef.current;
      const app = listed ? openWithChoice(clicked, listed.offered, listed.editorNames) : null;
      if (listed && app) {
        void runOpenWith({
          environmentId,
          input: { cwd, relativePath: listed.path, app },
        }).then((result) => {
          if (result._tag !== "Success") {
            reportFailure(
              "Couldn’t open",
              result._tag === "Failure" ? squashAtomCommandFailure(result) : null,
            );
          }
        });
        return true;
      }
      if (!MENU_CHOICES.has(clicked)) return false;
      act(clicked as MenuChoice, menuTargetsRef.current);
      return true;
    },
    /** Files and folders dropped from Finder or Explorer are copied into the folder under the pointer. */
    externalDrop: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!enabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        const folder = dropFolderUnder(event);
        const allowed = canImport() && folderWritable(folder);
        event.dataTransfer.dropEffect = allowed ? "copy" : "none";
        if (dropTarget?.folder !== folder || dropTarget.allowed !== allowed) {
          setDropTarget({ folder, allowed });
        }
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setDropTarget(null);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!enabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        const folder = dropFolderUnder(event);
        if (!canImport()) {
          toastManager.add({
            type: "error",
            title: "Files can be added only to a project on this computer",
          });
          return;
        }
        if (folderWritable(folder)) void importItems(pathsOf(event.dataTransfer.files), folder);
      },
    },
    /** Where a drop from outside goes, over the tree while one is dragged in. */
    dropOverlay:
      dropTarget === null
        ? null
        : ((
            <div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center rounded-md ring-2 ring-primary/60 ring-inset">
              <span className="mb-3 rounded-md bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md">
                {dropTarget.allowed
                  ? `Copy into ${dropTarget.folder ? baseName(dropTarget.folder) : "the project"}`
                  : canImport()
                    ? "Files can’t change this folder"
                    : "Files can be added only to a project on this computer"}
              </span>
            </div>
          ) as ReactNode),
    dialog,
  };
}
