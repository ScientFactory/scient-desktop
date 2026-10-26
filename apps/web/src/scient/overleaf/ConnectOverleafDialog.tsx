// SCIENT-OWNED: the one Connect to Overleaf dialog, opened by every entry point. It links a
// folder or brings a project in as a new folder, then runs and shows the first sync. "Add
// project" opens it after making the Scient project, bringing the paper in as a subfolder.
import type { EnvironmentId, ScientOverleafSyncResult } from "@t3tools/contracts";
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
import { ensureBrowseDirectoryPath } from "~/lib/projectPaths";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";
import { useProjectPathSearch } from "~/state/queries";

import { connectOverleaf, overleafRequestId, saveOverleafToken } from "./client";
import { runOverleafSync } from "./overleafActions";
import {
  folderNameProblem,
  newFolderPath,
  OVERLEAF_TOKEN_PAGE_URL,
  operationErrorText,
  overleafResultView,
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

const MADE_NOT_LINKED = "The project is made, but Overleaf isn't linked yet. ";

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
  const token = useOverleafTokenSaved(environmentId);
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<ConnectOverleafMode>(props.initialMode ?? "new");
  // The folder the person chose in this workspace: the parent for a new folder,
  // the folder itself for a link. Starts at the folder the dialog opened for.
  const [chosenFolder, setChosenFolder] = useState(folder);
  const [name, setName] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ _tag: "form" });
  const [projectName, setProjectName] = useState("");
  const [location, setLocation] = useState(newProject?.location ?? "");
  // Location and Paper folder stay folded behind the path they make until Change… or an error about them.
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
  const chosenLabel = chosenPath === "" ? "the project's top folder" : chosenPath;
  const rootPath = props.cwd.replace(/\/$/u, "");
  const fullPath = (relative: string) => (relative === "" ? rootPath : `${rootPath}/${relative}`);
  // The paper's folder joins the project's path once the person names it.
  const destination = `${location.trim() ? ensureBrowseDirectoryPath(location.trim()) : ""}${projectName.trim()}${name.trim() ? `/${name.trim()}` : ""}`;

  const connect = async () => {
    if (!tokenKnown) return;
    setError(null);
    const projectId = parseOverleafProjectInput(project);
    if (projectId === null) {
      setError("Paste the project's link from Overleaf, or its ID.");
      return;
    }
    if (newProject && madeRoot === null) {
      if (projectName.trim().length === 0) {
        setError("Name the project.");
        return;
      }
      const problem = folderNameProblem(projectName);
      if (problem !== null) {
        setError(problem);
        return;
      }
      if (location.trim().length === 0) {
        setError("Choose where the project goes.");
        setWhereOpen(true);
        return;
      }
    }
    if (!newProject) {
      const problem = workspaceFolderProblem(chosenFolder);
      if (problem !== null) {
        setError(problem);
        return;
      }
    }
    if (mode === "new") {
      const problem = folderNameProblem(name);
      if (problem !== null) {
        setError(problem);
        setWhereOpen(true);
        return;
      }
    }
    if (needsToken && tokenDraft.trim().length === 0) {
      setError("Add your Overleaf Git token.");
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
          setError(`${projectMade ? MADE_NOT_LINKED : ""}The token wasn't saved. Try again.`);
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
            `The project wasn't made: ${failure instanceof Error ? failure.message : "an error occurred."}`,
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
        setError(
          `${projectMade ? MADE_NOT_LINKED : ""}${refusalText({ reason: connected.reason })}`,
        );
        setPhase({ _tag: "form" });
        return;
      }
      const connection: OverleafConnection = { ...connected.connection, linkedHere: true };
      // A reconnected archive keeps its ID: nothing remembered from before applies to it.
      forgetOverleafConnection(environmentId, connection.connectionId);
      void reloadOverleafWorkspaces(environmentId, workspaceRoot);
      setPhase({ _tag: "working", step: "sync" });
      // The first sync runs straight away; its result is shown here.
      try {
        const result = await runOverleafSync({
          environmentId,
          workspaceRoot,
          connection,
          quiet: true,
        });
        setPhase({ _tag: "done", connection, result, syncError: null });
      } catch (syncError) {
        setPhase({
          _tag: "done",
          connection,
          result: null,
          syncError: operationErrorText(syncError),
        });
      }
    } catch (failure) {
      setError(`${projectMade ? MADE_NOT_LINKED : ""}${operationErrorText(failure)}`);
      setPhase({ _tag: "form" });
    }
  };

  const view = phase._tag === "done" && phase.result ? overleafResultView(phase.result) : null;

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
              {newProject ? "Add Overleaf project" : "Connect to Overleaf"}
            </span>
          </DialogTitle>
        </DialogHeader>
        {phase._tag === "done" ? (
          <DialogPanel>
            <div className="flex flex-col gap-2" role="status">
              <p className="text-sm">
                Linked{" "}
                {newProject
                  ? `${projectName.trim()}/${phase.connection.folder}`
                  : phase.connection.folder === ""
                    ? "this project"
                    : phase.connection.folder}
                .
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
                  The first sync didn't run: {phase.syncError}
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
                  <Label htmlFor="overleaf-project">Overleaf project</Label>
                  <Input
                    id="overleaf-project"
                    size="sm"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    placeholder="Project link or ID"
                    value={project}
                    onChange={(event) => setProject(event.target.value)}
                  />
                </div>
                {newProject ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="overleaf-new-project-name">Project name</Label>
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
                          <span className="shrink-0">Goes in</span>
                          <span
                            id="overleaf-new-project-destination"
                            className="min-w-0 break-all text-foreground/80"
                          >
                            {destination}
                          </span>
                          {whereOpen ? null : (
                            <InlineButton tone="muted" onClick={() => setWhereOpen(true)}>
                              Change…
                            </InlineButton>
                          )}
                        </p>
                      ) : null}
                    </div>
                    {whereOpen ? (
                      <>
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-new-project-location">Location</Label>
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
                                      aria-label="Choose a folder"
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
                                <TooltipPopup>Choose a folder</TooltipPopup>
                              </Tooltip>
                            ) : null}
                          </div>
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-new-project-folder">Paper folder</Label>
                          <Input
                            id="overleaf-new-project-folder"
                            size="sm"
                            placeholder={EXAMPLE_FOLDER_NAME}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                          />
                        </div>
                      </>
                    ) : null}
                  </>
                ) : (
                  <RadioGroup
                    aria-label="Where it goes"
                    value={mode}
                    onValueChange={(value) => setMode(value as ConnectOverleafMode)}
                  >
                    <Label>
                      <Radio value="new" />
                      Bring it in as a new folder
                    </Label>
                    {mode === "new" ? (
                      <div className="ms-6 grid gap-1.5">
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-inside">Inside</Label>
                          <WorkspaceFolderField
                            id="overleaf-inside"
                            environmentId={environmentId}
                            cwd={props.cwd}
                            value={chosenFolder}
                            onChange={setChosenFolder}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-folder-name">Folder name</Label>
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
                            <span className="shrink-0">Goes in</span>
                            <span
                              id="overleaf-destination"
                              className="min-w-0 break-all text-foreground/80"
                            >
                              {fullPath(newFolderPath(chosenPath, name.trim()))}
                            </span>
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <Label>
                      <Radio value="link" />
                      <span className="min-w-0 truncate">{`Link ${chosenLabel}`}</span>
                    </Label>
                    {mode === "link" ? (
                      <div className="ms-6 grid gap-1.5">
                        <div className="grid gap-1.5">
                          <Label htmlFor="overleaf-folder">Folder</Label>
                          <WorkspaceFolderField
                            id="overleaf-folder"
                            environmentId={environmentId}
                            cwd={props.cwd}
                            value={chosenFolder}
                            onChange={setChosenFolder}
                          />
                        </div>
                        <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
                          <span className="shrink-0">Links</span>
                          <span className="min-w-0 break-all text-foreground/80">
                            {fullPath(chosenPath)}
                          </span>
                        </p>
                      </div>
                    ) : null}
                  </RadioGroup>
                )}
                {needsToken ? (
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="overleaf-token">Overleaf Git token</Label>
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
                        Create a token on Overleaf
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
                  See changes
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={onClose}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                form="connect-overleaf-form"
                disabled={busy || !tokenKnown}
              >
                {phase._tag === "working"
                  ? phase.step === "sync"
                    ? "Syncing…"
                    : phase.step === "project"
                      ? "Creating…"
                      : "Connecting…"
                  : newProject
                    ? "Add"
                    : "Connect"}
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
    ...(props.value.trim() === "" ? [{ path: "", label: "Project's top folder" }] : []),
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
        placeholder="Project's top folder"
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
