// SCIENT-OWNED: the one Connect to Overleaf dialog, opened by every entry point. It links a
// folder or brings a project in as a new folder, then runs and shows the first sync. "Add
// project" opens it after making the Scient project, bringing the paper in as a subfolder.
import type { EnvironmentId, ScientOverleafSyncResult } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { ExternalLinkIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";

import { SecretInput } from "~/components/settings/SecretInput";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Button, InlineButton } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";
import { useProjectPathSearch } from "~/state/queries";

import {
  connectOverleaf,
  listOverleafConnections,
  overleafRequestId,
  saveOverleafToken,
} from "./client";
import { reportOverleafSync, runOverleafSync, unlinkOverleaf } from "./overleafActions";
import {
  folderNameProblem,
  newFolderPath,
  OVERLEAF_TOKEN_PAGE_URL,
  operationErrorText,
  overleafResultView,
  overleafSyncSucceeded,
  parseOverleafProjectInput,
  refusalText,
  workspaceFolderPath,
  workspaceFolderProblem,
} from "./overleafModel";
import {
  forgetOverleafConnection,
  reloadOverleafWorkspaces,
  setOverleafTokenSaved,
  useOverleafTokenSaved,
  type OverleafConnection,
} from "./overleafStore";

export type ConnectOverleafMode = "new" | "link";

/** Only an example in the empty folder-name field; no name is assumed. */
const EXAMPLE_FOLDER_NAME = "paper";

type Phase =
  | { readonly _tag: "form" }
  | { readonly _tag: "working"; readonly step: "token" | "project" | "connect" | "sync" }
  | {
      readonly _tag: "done";
      readonly connection: OverleafConnection;
      readonly result: ScientOverleafSyncResult | null;
      readonly syncError: string | null;
    };

/** Add project ▸ Overleaf project: the Scient project the paper goes in is made first. */
export interface OverleafNewProject {
  /** The folder new projects go in until the person changes it. */
  readonly location: string;
  /** The system's folder chooser; absent where there is none. */
  readonly chooseFolder?: ((current: string) => Promise<string | null>) | undefined;
  /** Makes the Scient project at `root` (or uses the one there) and resolves to its workspace root. */
  readonly create: (root: string) => Promise<string>;
}

/**
 * A path that wraps only after its slashes: each segment is one unit, so a hyphen or a
 * single letter never starts a line; a segment wider than the line breaks inside itself.
 */
function WrappingPath(props: { readonly path: string }) {
  return props.path.split(/(?<=\/)/u).map((part, index) => (
    // oxlint-disable-next-line react/no-array-index-key -- path segments repeat and never reorder
    <span key={index} className="inline-block max-w-full [overflow-wrap:anywhere]">
      {part}
    </span>
  ));
}

export function ConnectOverleafDialog(props: {
  readonly environmentId: EnvironmentId;
  /** The workspace the folder belongs to; unused with `newProject`. */
  readonly cwd: string;
  /** The selected folder, relative to the workspace; empty for the project's top. */
  readonly folder: string;
  readonly initialMode?: ConnectOverleafMode;
  /** Opens the new link's review tab ("See changes"); absent without a side panel. */
  readonly onSeeChanges?: ((connection: OverleafConnection) => void) | undefined;
  /** Makes a new Scient project and brings the paper in as a subfolder of it. */
  readonly newProject?: OverleafNewProject | undefined;
  readonly onClose: () => void;
}) {
  const { environmentId, folder, onClose, newProject } = props;
  const gt = useGT();
  const messages = useMessages();
  const token = useOverleafTokenSaved(environmentId);
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<ConnectOverleafMode>(props.initialMode ?? "new");
  // The folder the person chose in this workspace: the parent for a new folder,
  // the folder itself for a link. Starts at the folder the dialog opened for.
  const [chosenFolder, setChosenFolder] = useState(folder);
  const [folderNameDraft, setName] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The standing link of this project that refused the connect, when one did.
  const [linkedAlready, setLinkedAlready] = useState<OverleafConnection | null>(null);
  const [phase, setPhase] = useState<Phase>({ _tag: "form" });
  const [projectName, setProjectName] = useState("");
  const name =
    folderNameDraft ??
    (newProject && folderNameProblem(projectName, messages) === null
      ? workspaceFolderPath(projectName)
      : "");
  const [location, setLocation] = useState(newProject?.location ?? "");
  // Location stays folded behind its path until Change… or an error about it.
  const [whereOpen, setWhereOpen] = useState(false);
  // Once made, the project stays: a refused link is tried again in it, never made twice.
  const [madeRoot, setMadeRoot] = useState<string | null>(null);
  const cwd = newProject ? (madeRoot ?? "") : props.cwd;
  const busy = phase._tag === "working";
  // Until the token's status is known, Connect waits: without it, a missing
  // token would only show after the project was made.
  const tokenKnown = token.loaded;
  const needsToken = token.loaded && !token.saved;
  const chosenPath = workspaceFolderPath(chosenFolder);
  const rootPath = props.cwd.replace(/\/$/u, "");
  const fullPath = (relative: string) => (relative === "" ? rootPath : `${rootPath}/${relative}`);
  // The paper's folder joins the project's path once the person names it.
  const destination = `${location.trim() ? ensureBrowseDirectoryPath(location.trim()) : ""}${projectName.trim()}${name.trim() ? `/${name.trim()}` : ""}`;

  /** A failure after the project was made says the project stays. */
  const madeNotLinked = (projectMade: boolean, reason: string) =>
    projectMade
      ? gt("The project is made, but Overleaf isn't linked yet. {reason}", { reason })
      : reason;

  const connect = async () => {
    if (!tokenKnown) return;
    setError(null);
    setLinkedAlready(null);
    const projectId = parseOverleafProjectInput(project);
    if (projectId === null) {
      setError(gt("Paste the project's link from Overleaf, or its ID."));
      return;
    }
    if (newProject && madeRoot === null) {
      if (projectName.trim().length === 0) {
        setError(gt("Name the project."));
        return;
      }
      const problem = folderNameProblem(projectName, messages);
      if (problem !== null) {
        setError(problem);
        return;
      }
      if (location.trim().length === 0) {
        setError(gt("Choose where the project goes."));
        setWhereOpen(true);
        return;
      }
    }
    if (!newProject) {
      const problem = workspaceFolderProblem(chosenFolder, messages);
      if (problem !== null) {
        setError(problem);
        return;
      }
    }
    if (mode === "new") {
      const problem = folderNameProblem(name, messages);
      if (problem !== null) {
        setError(problem);
        setWhereOpen(true);
        return;
      }
    }
    if (needsToken && tokenDraft.trim().length === 0) {
      setError(gt("Add your Overleaf Git token."));
      return;
    }
    // A failure after the project is made leaves it in place and says so.
    let projectMade = madeRoot !== null;
    try {
      if (needsToken) {
        setPhase({ _tag: "working", step: "token" });
        const saved = await saveOverleafToken(environmentId, tokenDraft.trim());
        setOverleafTokenSaved(environmentId, saved.saved);
        if (!saved.saved) {
          // Nothing is made without a token Overleaf can be asked with.
          setError(madeNotLinked(projectMade, gt("The token wasn't saved. Try again.")));
          setPhase({ _tag: "form" });
          return;
        }
        setTokenDraft("");
      }
      let workspaceRoot = cwd;
      if (newProject && madeRoot === null) {
        setPhase({ _tag: "working", step: "project" });
        try {
          workspaceRoot = await newProject.create(
            `${ensureBrowseDirectoryPath(location.trim())}${projectName.trim()}`,
          );
        } catch (failure) {
          setError(
            failure instanceof Error
              ? gt("The project wasn't made: {reason}", { reason: failure.message })
              : gt("The project wasn't made: an error occurred."),
          );
          // Often the location: show it.
          setWhereOpen(true);
          setPhase({ _tag: "form" });
          return;
        }
        setMadeRoot(workspaceRoot);
        projectMade = true;
      }
      setPhase({ _tag: "working", step: "connect" });
      const connected = await connectOverleaf(environmentId, {
        workspaceRoot,
        folder:
          mode === "new"
            ? newFolderPath(newProject ? folder : chosenPath, name)
            : newProject
              ? folder
              : chosenPath,
        create: mode === "new",
        project: projectId,
        requestId: overleafRequestId(),
      });
      if (connected._tag === "refused") {
        // Asked now, and only of this copy: another worktree's link is not what refused this.
        const existing =
          connected.reason === "project-already-linked"
            ? (await listOverleafConnections(environmentId, workspaceRoot)).connections.find(
                (link) => link.linkedHere && link.projectId === projectId,
              )
            : undefined;
        setLinkedAlready(existing ?? null);
        setError(
          existing
            ? existing.folder === ""
              ? gt("This Overleaf project is already linked to the project's top folder.")
              : gt("This Overleaf project is already linked to {folder}.", {
                  folder: existing.folder,
                })
            : madeNotLinked(
                projectMade,
                refusalText({ reason: connected.reason }, "connect", false, messages),
              ),
        );
        setPhase({ _tag: "form" });
        return;
      }
      const connection: OverleafConnection = { ...connected.connection, linkedHere: true };
      // A reconnected archive keeps its ID: nothing remembered from before applies to it.
      forgetOverleafConnection(environmentId, connection.connectionId);
      void reloadOverleafWorkspaces(environmentId, workspaceRoot);
      setPhase({ _tag: "working", step: "sync" });
      // The first sync runs straight away; only an unfinished result keeps the dialog open.
      try {
        const result = await runOverleafSync({
          environmentId,
          workspaceRoot,
          connection,
          quiet: true,
        });
        if (result && overleafSyncSucceeded(result)) {
          reportOverleafSync(
            {
              connection,
              openReview: props.onSeeChanges ? () => props.onSeeChanges?.(connection) : undefined,
            },
            result,
          );
          onClose();
          return;
        }
        setPhase({ _tag: "done", connection, result, syncError: null });
      } catch (syncError) {
        setPhase({
          _tag: "done",
          connection,
          result: null,
          syncError: operationErrorText(syncError, "sync", messages),
        });
      }
    } catch (failure) {
      setError(madeNotLinked(projectMade, operationErrorText(failure, "connect", messages)));
      setPhase({ _tag: "form" });
    }
  };

  /** Unlinks the folder the project is linked to, then links it here instead. */
  const linkHereInstead = async (link: OverleafConnection) => {
    setPhase({ _tag: "working", step: "connect" });
    if (await unlinkOverleaf(environmentId, cwd, link.connectionId)) await connect();
    else setPhase({ _tag: "form" });
  };

  const view =
    phase._tag === "done" && phase.result ? overleafResultView(phase.result, messages) : null;
  const linkedTarget =
    phase._tag !== "done"
      ? null
      : newProject
        ? `${projectName.trim()}/${phase.connection.folder}`
        : phase.connection.folder === ""
          ? null
          : phase.connection.folder;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <OverleafMark aria-hidden className="size-4" />
              {newProject ? gt("Add Overleaf project") : gt("Connect to Overleaf")}
            </span>
          </DialogTitle>
        </DialogHeader>
        {phase._tag === "done" ? (
          <DialogPanel>
            <div className="flex flex-col gap-2" role="status">
              <p className="text-sm">
                {linkedTarget === null ? (
                  <T>Linked this project.</T>
                ) : (
                  <T>
                    Linked <Var>{linkedTarget}</Var>.
                  </T>
                )}
              </p>
              {view ? (
                <>
                  <p className="text-sm font-medium">{view.title}</p>
                  {view.lines.map((line) => (
                    <p key={line} className="text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </>
              ) : phase.syncError ? (
                <p className="text-sm text-destructive" role="alert">
                  <T>
                    The first sync didn't run: <Var>{phase.syncError}</Var>
                  </T>
                </p>
              ) : null}
            </div>
          </DialogPanel>
        ) : (
          <DialogPanel>
            <form
              id="connect-overleaf-form"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void connect();
              }}
            >
              <fieldset disabled={busy} className="contents">
                <div className="grid gap-1.5">
                  <Label htmlFor="overleaf-project">
                    <T>Overleaf project</T>
                  </Label>
                  <Input
                    id="overleaf-project"
                    size="sm"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    placeholder={gt("Project link or ID")}
                    value={project}
                    onChange={(event) => setProject(event.target.value)}
                  />
                </div>
                {newProject ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="overleaf-new-project-name">
                        <T>Project name</T>
                      </Label>
                      <Input
                        id="overleaf-new-project-name"
                        size="sm"
                        autoComplete="off"
                        disabled={madeRoot !== null}
                        aria-describedby={
                          projectName.trim() ? "overleaf-new-project-destination" : undefined
                        }
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                      />
                      {projectName.trim() ? (
                        <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
                          <span className="shrink-0">
                            <T context="label before the folder path a project goes in">Goes in</T>
                          </span>
                          <span
                            id="overleaf-new-project-destination"
                            className="min-w-0 [overflow-wrap:anywhere] text-foreground/80"
                          >
                            <WrappingPath path={destination} />
                          </span>
                          {whereOpen ? null : (
                            <InlineButton tone="muted" onClick={() => setWhereOpen(true)}>
                              <T>Change…</T>
                            </InlineButton>
                          )}
                        </p>
                      ) : null}
                    </div>
                    {whereOpen ? (
                      <>
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-new-project-location">
                            <T context="where a new project folder is made">Location</T>
                          </Label>
                          <div className="flex min-w-0 items-center gap-1">
                            <Input
                              id="overleaf-new-project-location"
                              size="sm"
                              autoComplete="off"
                              spellCheck={false}
                              className="min-w-0 flex-1"
                              disabled={madeRoot !== null}
                              value={location}
                              onChange={(event) => setLocation(event.target.value)}
                            />
                            {newProject.chooseFolder ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      type="button"
                                      variant="ghost-muted"
                                      size="icon-xs"
                                      className="shrink-0"
                                      aria-label={gt("Choose a folder")}
                                      disabled={madeRoot !== null}
                                      onClick={() => {
                                        void newProject.chooseFolder?.(location).then((picked) => {
                                          if (picked) setLocation(picked);
                                        });
                                      }}
                                    />
                                  }
                                >
                                  <FolderOpenIcon
                                    aria-hidden
                                    className="scient-quiet-icon size-[17px]"
                                    strokeWidth={1.75}
                                  />
                                </TooltipTrigger>
                                <TooltipPopup>
                                  <T>Choose a folder</T>
                                </TooltipPopup>
                              </Tooltip>
                            ) : null}
                          </div>
                        </div>
                      </>
                    ) : null}
                    <div className="grid gap-1.5">
                      <Label htmlFor="overleaf-new-project-folder">
                        <T>Paper folder</T>
                      </Label>
                      <Input
                        id="overleaf-new-project-folder"
                        size="sm"
                        placeholder={EXAMPLE_FOLDER_NAME}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <RadioGroup
                    aria-label={gt("Where it goes")}
                    value={mode}
                    onValueChange={(value) => setMode(value as ConnectOverleafMode)}
                  >
                    <Label>
                      <Radio value="new" />
                      <T>Bring it in as a new folder</T>
                    </Label>
                    {mode === "new" ? (
                      <div className="ms-6 grid gap-1.5">
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-inside">
                            <T context="the folder a new folder is made in">Inside</T>
                          </Label>
                          <WorkspaceFolderField
                            id="overleaf-inside"
                            environmentId={environmentId}
                            cwd={props.cwd}
                            value={chosenFolder}
                            onChange={setChosenFolder}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-folder-name">
                            <T>Folder name</T>
                          </Label>
                          <Input
                            id="overleaf-folder-name"
                            size="sm"
                            placeholder={EXAMPLE_FOLDER_NAME}
                            aria-describedby={name.trim() ? "overleaf-destination" : undefined}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                          />
                        </div>
                        {name.trim() ? (
                          <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
                            <span className="shrink-0">
                              <T context="label before the folder path a project goes in">
                                Goes in
                              </T>
                            </span>
                            <span
                              id="overleaf-destination"
                              className="min-w-0 [overflow-wrap:anywhere] text-foreground/80"
                            >
                              <WrappingPath
                                path={fullPath(newFolderPath(chosenPath, name.trim()))}
                              />
                            </span>
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <Label>
                      <Radio value="link" />
                      <span className="min-w-0 truncate">
                        {chosenPath === ""
                          ? gt("Link the project's top folder")
                          : gt("Link {folder}", { folder: chosenPath })}
                      </span>
                    </Label>
                    {mode === "link" ? (
                      <div className="ms-6 grid gap-1.5">
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-folder">
                            <T>Folder</T>
                          </Label>
                          <WorkspaceFolderField
                            id="overleaf-folder"
                            environmentId={environmentId}
                            cwd={props.cwd}
                            value={chosenFolder}
                            onChange={setChosenFolder}
                          />
                        </div>
                        <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
                          <span className="shrink-0">
                            <T context="label before the folder path that will be linked">Links</T>
                          </span>
                          <span className="min-w-0 [overflow-wrap:anywhere] text-foreground/80">
                            <WrappingPath path={fullPath(chosenPath)} />
                          </span>
                        </p>
                      </div>
                    ) : null}
                  </RadioGroup>
                )}
                {needsToken ? (
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="overleaf-token">
                        <T>Overleaf Git token</T>
                      </Label>
                      <InlineButton
                        tone="muted"
                        className="text-xs"
                        render={
                          <a
                            href={OVERLEAF_TOKEN_PAGE_URL}
                            target="_blank"
                            rel="noreferrer noopener"
                          />
                        }
                      >
                        <T>Create a token on Overleaf</T>
                        <ExternalLinkIcon aria-hidden className="size-3" />
                      </InlineButton>
                    </div>
                    <SecretInput
                      id="overleaf-token"
                      size="sm"
                      value={tokenDraft}
                      onChange={(event) => setTokenDraft(event.target.value)}
                    />
                  </div>
                ) : null}
              </fieldset>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              {linkedAlready ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => void linkHereInstead(linkedAlready)}
                >
                  <T>Unlink it and link here</T>
                </Button>
              ) : null}
            </form>
          </DialogPanel>
        )}
        <DialogFooter variant="bare" className="mt-2">
          {phase._tag === "done" ? (
            <>
              {view?.hasChanges && props.onSeeChanges ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    props.onSeeChanges?.(phase.connection);
                    onClose();
                  }}
                >
                  <T>See changes</T>
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={onClose}>
                <T context="button, closes the dialog">Done</T>
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button
                type="submit"
                size="sm"
                form="connect-overleaf-form"
                disabled={busy || !tokenKnown}
              >
                {phase._tag === "working"
                  ? phase.step === "sync"
                    ? gt("Syncing…")
                    : phase.step === "project"
                      ? gt("Creating…")
                      : gt("Connecting…")
                  : newProject
                    ? gt("Add", { $context: "button, adds the Overleaf project" })
                    : gt("Connect", { $context: "button, links the folder to Overleaf" })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A folder of this workspace, picked from its folders or typed as a path from
 * the project's top. An empty field is the project's top folder.
 */
function WorkspaceFolderField(props: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const gt = useGT();
  const search = useProjectPathSearch(
    { environmentId: props.environmentId, cwd: props.cwd, query: props.value, kind: "directory" },
    20,
    { allowEmptyQuery: true },
  );
  const folders = search.entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => workspaceFolderPath(entry.path))
    .filter((path, index, all) => path !== "" && all.indexOf(path) === index);
  const items = [
    ...(props.value.trim() === "" ? [{ path: "", label: gt("Project's top folder") }] : []),
    ...folders.map((path) => ({ path, label: path })),
  ];
  return (
    <Autocomplete
      items={items}
      itemToStringValue={(item) => item.path}
      mode="none"
      openOnInputClick
      value={props.value}
      onValueChange={(value) => props.onChange(value)}
    >
      <AutocompleteInput
        id={props.id}
        size="sm"
        autoComplete="off"
        spellCheck={false}
        placeholder={gt("Project's top folder")}
      />
      {items.length > 0 ? (
        <AutocompletePopup>
          <AutocompleteList className="max-h-60">
            {items.map((item) => (
              <AutocompleteItem key={item.path === "" ? "top" : item.path} value={item}>
                <span className="min-w-0 truncate">{item.label}</span>
              </AutocompleteItem>
            ))}
          </AutocompleteList>
        </AutocompletePopup>
      ) : null}
    </Autocomplete>
  );
}
