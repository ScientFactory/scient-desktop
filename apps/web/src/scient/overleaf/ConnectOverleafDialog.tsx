// SCIENT-OWNED: the one Connect to Overleaf dialog. The Files bar's Connect
// menu, a folder's right-click menu and Project Settings all open it. It links
// a folder, or brings a project in as a new folder, then runs the first sync
// and shows its result.
import type { EnvironmentId, ScientOverleafSyncResult } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { SecretInput } from "~/components/settings/SecretInput";
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
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";

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
} from "./overleafModel";
import {
  forgetOverleafConnection,
  loadOverleafWorkspace,
  setOverleafTokenSaved,
  useOverleafTokenSaved,
  type OverleafConnection,
} from "./overleafStore";

export type ConnectOverleafMode = "new" | "link";

/** The name a new folder gets until the person changes it. */
const DEFAULT_OVERLEAF_FOLDER_NAME = "paper";

type Phase =
  | { readonly _tag: "form" }
  | { readonly _tag: "working"; readonly step: "token" | "connect" | "sync" }
  | {
      readonly _tag: "done";
      readonly connection: OverleafConnection;
      readonly result: ScientOverleafSyncResult | null;
      readonly syncError: string | null;
    };

export function ConnectOverleafDialog(props: {
  readonly environmentId: EnvironmentId;
  /** The workspace the folder belongs to. */
  readonly cwd: string;
  /** The selected folder, relative to the workspace; empty for the project's top. */
  readonly folder: string;
  readonly initialMode?: ConnectOverleafMode;
  /** Project Settings: the folder to link is typed, since nothing is selected there. */
  readonly folderEditable?: boolean;
  /** Opens the new link's review tab ("See changes"); absent without a side panel. */
  readonly onSeeChanges?: ((connection: OverleafConnection) => void) | undefined;
  readonly onClose: () => void;
}) {
  const { environmentId, cwd, folder, onClose } = props;
  const token = useOverleafTokenSaved(environmentId);
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<ConnectOverleafMode>(props.initialMode ?? "new");
  const [name, setName] = useState(DEFAULT_OVERLEAF_FOLDER_NAME);
  const [linkFolder, setLinkFolder] = useState(folder);
  const [tokenDraft, setTokenDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ _tag: "form" });
  const busy = phase._tag === "working";
  const needsToken = token.loaded && !token.saved;
  const folderLabel = folder === "" ? "the project's top folder" : folder;

  const connect = async () => {
    setError(null);
    const projectId = parseOverleafProjectInput(project);
    if (projectId === null) {
      setError("Paste the project's link from Overleaf, or its ID.");
      return;
    }
    if (mode === "new") {
      const problem = folderNameProblem(name);
      if (problem !== null) {
        setError(problem);
        return;
      }
    }
    if (needsToken && tokenDraft.trim().length === 0) {
      setError("Add your Overleaf Git token.");
      return;
    }
    try {
      if (needsToken) {
        setPhase({ _tag: "working", step: "token" });
        const saved = await saveOverleafToken(environmentId, tokenDraft.trim());
        setOverleafTokenSaved(environmentId, saved.saved);
        setTokenDraft("");
      }
      setPhase({ _tag: "working", step: "connect" });
      const connected = await connectOverleaf(environmentId, {
        workspaceRoot: cwd,
        folder:
          mode === "new"
            ? newFolderPath(folder, name)
            : linkFolder.trim().replace(/^\/+|\/+$/gu, ""),
        create: mode === "new",
        project: projectId,
        requestId: overleafRequestId(),
      });
      if (connected._tag === "refused") {
        setError(refusalText({ reason: connected.reason }));
        setPhase({ _tag: "form" });
        return;
      }
      const connection: OverleafConnection = { ...connected.connection, linkedHere: true };
      // A reconnected archive keeps its ID: nothing remembered from before applies to it.
      forgetOverleafConnection(environmentId, connection.connectionId);
      void loadOverleafWorkspace(environmentId, cwd, { force: true });
      setPhase({ _tag: "working", step: "sync" });
      // The first sync runs straight away; its result is shown here.
      try {
        const result = await runOverleafSync({
          environmentId,
          workspaceRoot: cwd,
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
      setError(operationErrorText(failure));
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
              Connect to Overleaf
            </span>
          </DialogTitle>
        </DialogHeader>
        {phase._tag === "done" ? (
          <DialogPanel>
            <div className="flex flex-col gap-2" role="status">
              <p className="text-sm">
                Linked {phase.connection.folder === "" ? "this project" : phase.connection.folder}.
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
                    <div className="ms-6 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                      {folder === "" ? null : <span className="truncate">{folder}/</span>}
                      <Input
                        size="sm"
                        aria-label="Folder name"
                        className="min-w-0 flex-1"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  ) : null}
                  <Label>
                    <Radio value="link" />
                    <span className="min-w-0 truncate">
                      {props.folderEditable ? "Link a folder" : `Link ${folderLabel}`}
                    </span>
                  </Label>
                  {mode === "link" && props.folderEditable ? (
                    <Input
                      size="sm"
                      aria-label="Folder to link"
                      className="ms-6 w-auto"
                      placeholder="paper"
                      value={linkFolder}
                      onChange={(event) => setLinkFolder(event.target.value)}
                    />
                  ) : null}
                </RadioGroup>
                {needsToken ? (
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="overleaf-token">Overleaf Git token</Label>
                      <InlineButton
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
        <DialogFooter>
          {phase._tag === "done" ? (
            <>
              {view?.hasChanges && props.onSeeChanges ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    props.onSeeChanges?.(phase.connection);
                    onClose();
                  }}
                >
                  See changes
                </Button>
              ) : null}
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="connect-overleaf-form" disabled={busy}>
                {phase._tag === "working"
                  ? phase.step === "sync"
                    ? "Syncing…"
                    : "Connecting…"
                  : "Connect"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
