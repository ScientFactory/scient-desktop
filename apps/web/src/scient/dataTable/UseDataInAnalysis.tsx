import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { use, useRef, useState } from "react";

import { ProjectFilePickerForTarget } from "~/components/files/ProjectFilePicker";
import { Button } from "~/components/ui/button";
import { CommandDialog, CommandDialogPopup } from "~/components/ui/command";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { computeSourceLanguageForPath } from "~/scient/compute/computeSourceLanguage";
import { NotebookFreshRunWarning } from "~/scient/notebook/NotebookFreshRunWarning";
import { notebookRunDraftKey, useNotebookRunDrafts } from "~/scient/notebook/notebookRunDrafts";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  dataInputSnippet,
  dataSnippetLanguage,
  type DataSnippetLanguage,
} from "./dataInputSnippet";
import { GridActionMenuContext } from "./gridActionMenu";
import type { DataWorkspaceFile } from "./DataViewActions";

export function UseDataInAnalysis(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly file: DataWorkspaceFile;
  readonly sheet: number;
}) {
  const { environmentId, threadId, file } = props;
  const gt = useGT();
  const menu = use(GridActionMenuContext);
  const languages = [
    { id: "python", label: gt("Python") },
    { id: "r", label: gt("R") },
    { id: "julia", label: gt("Julia") },
  ] as const;
  const [picking, setPicking] = useState(false);
  const [scriptPath, setScriptPath] = useState<string | null>(null);
  const [language, setLanguage] = useState<DataSnippetLanguage>("python");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard();
  const selection = useRef(0);
  const readNotebook = useAtomCommand(computeEnvironment.notebookRead, { reportFailure: false });
  const loadSetup = useAtomCommand(computeEnvironment.resultsSetup, { reportFailure: false });
  const rerun = useAtomCommand(computeEnvironment.resultsRerun, { reportFailure: false });
  const canRun = useAtomValue(computeEnvironment.resultsRerun.permissionAtom(environmentId));
  const snippet = dataInputSnippet(file.path, language, props.sheet);
  const draftKey =
    scriptPath !== null && /\.ipynb$/iu.test(scriptPath)
      ? notebookRunDraftKey(environmentId, file.cwd, scriptPath)
      : null;
  const hasPendingParameters = useNotebookRunDrafts(
    (state) => draftKey !== null && state.drafts[draftKey]?.parameters !== undefined,
  );

  const select = async (path: string) => {
    if (
      path === file.path ||
      (!/\.ipynb$/iu.test(path) && computeSourceLanguageForPath(path) === null)
    ) {
      toastManager.add({ type: "error", title: gt("Choose a script or notebook") });
      return;
    }
    setPicking(false);
    const request = ++selection.current;
    let nextLanguage = dataSnippetLanguage(path);
    if (/\.ipynb$/iu.test(path)) {
      const result = await readNotebook({ environmentId, input: { cwd: file.cwd, path } });
      if (selection.current !== request) return;
      if (result._tag === "Success") {
        const language = result.value?.language.toLowerCase();
        if (language === "r" || language === "julia") nextLanguage = language;
      }
    }
    setLanguage(nextLanguage);
    setScriptPath(path);
    setError(null);
  };

  const run = async () => {
    if (scriptPath === null || busy) return;
    const draft = draftKey === null ? undefined : useNotebookRunDrafts.getState().drafts[draftKey];
    setBusy(true);
    setError(null);
    await (async () => {
      let declared = draft?.inputs;
      if (declared === undefined) {
        const setup = await loadSetup({ environmentId, input: { cwd: file.cwd, scriptPath } });
        if (setup._tag !== "Success") throw squashAtomCommandFailure(setup);
        declared = setup.value.inputs;
      }
      const inputs = [...new Set([...declared, file.path])];
      const launched = await rerun({
        environmentId,
        input: {
          cwd: file.cwd,
          scriptPath,
          inputs,
          ...(draft?.parameters === undefined ? {} : { parameters: draft.parameters }),
        },
      });
      if (launched._tag !== "Success") throw squashAtomCommandFailure(launched);
      if (launched.value._tag === "failed") {
        setError(launched.value.message);
        return;
      }
      if (draftKey !== null && draft?.inputs !== undefined) {
        const { drafts, update } = useNotebookRunDrafts.getState();
        if (drafts[draftKey]?.inputs === draft.inputs) update(draftKey, { inputs });
      }
      toastManager.add({ type: "success", title: gt("Analysis result saved") });
      setScriptPath(null);
    })()
      .catch((failure: unknown) => setError(String(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {menu ? (
        <MenuItem
          focus="edge"
          disabled={!canRun}
          onClick={() => menu.launch(() => setPicking(true))}
        >
          {gt("Use in analysis…")}
        </MenuItem>
      ) : (
        <Button size="xs" variant="ghost" disabled={!canRun} onClick={() => setPicking(true)}>
          {gt("Use in analysis…")}
        </Button>
      )}
      <CommandDialog open={picking} onOpenChange={setPicking}>
        {picking ? (
          <CommandDialogPopup
            aria-label={gt("Choose analysis file")}
            padding="none"
            finalFocus={menu?.finalFocus}
          >
            <ProjectFilePickerForTarget
              setOpen={setPicking}
              actionLabel={gt("Choose script or notebook")}
              target={{
                environmentId,
                cwd: file.cwd,
                threadRef: { environmentId, threadId },
                projectName: file.cwd.split(/[\\/]/u).at(-1) ?? "",
              }}
              onSelectFile={(path) => void select(path)}
            />
          </CommandDialogPopup>
        ) : null}
      </CommandDialog>
      <Dialog
        open={scriptPath !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setScriptPath(null);
        }}
      >
        <DialogPopup finalFocus={menu?.finalFocus}>
          <DialogHeader>
            <DialogTitle>{gt("Use in analysis")}</DialogTitle>
            <DialogDescription>
              {gt("Declare {file} as an input when you run {analysis}.", {
                file: file.path,
                analysis: scriptPath ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {gt("Copy this example into your script or notebook to read the input.")}
            </p>
            <div className="flex items-center justify-between gap-2">
              <Select
                value={language}
                onValueChange={(value) => {
                  if (value) setLanguage(value);
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Example language")}>
                  <SelectValue>{languages.find(({ id }) => id === language)?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {languages.map(({ id, label }) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={!snippet}
                onClick={() => copyToClipboard(snippet, undefined)}
              >
                {gt("Copy code")}
              </Button>
            </div>
            {snippet ? (
              <pre className="overflow-auto rounded-md bg-muted p-2 text-xs" dir="ltr">
                <code>{snippet}</code>
              </pre>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {draftKey === null ? null : (
              <p className="text-xs text-muted-foreground">
                <NotebookFreshRunWarning />
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy || scriptPath === null}
              onClick={() => {
                if (scriptPath === null) return;
                file.onOpenPath(scriptPath);
                setScriptPath(null);
              }}
            >
              {gt("Open analysis file")}
            </Button>
            <Button disabled={!canRun || busy || scriptPath === null} onClick={() => void run()}>
              {busy
                ? gt("Running…")
                : draftKey !== null && !hasPendingParameters
                  ? gt("Run with input and saved values")
                  : gt("Run fresh with input")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
