import { Play } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ComputeExecutionId,
  type ComputeSessionRecord,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";

import {
  createScientNestedCodeEditor,
  type ScientNestedCodeEditor,
} from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import { ProjectFilePickerForTarget } from "~/components/files/ProjectFilePicker";
import { Button } from "~/components/ui/button";
import { CommandDialog, CommandDialogPopup } from "~/components/ui/command";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useStableCallback } from "~/hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useCreateNewDocument } from "~/scient/documents/useCreateNewDocument";
import { useNewDocumentFiles } from "~/scient/documents/useNewDocumentFiles";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";

import { ComputeLanguageLogo } from "./ComputeLanguageMark";
import { useComputeConsoleStore } from "./computeConsoleStore";
import { createComputeContextId, type ComputeContextId } from "./computeContextStore";
import { computeRuntimeChoiceLabel } from "./computeFileSurfaceModel";
import { reportComputeFailure } from "./ComputeSessionControls";
import type { ComputeSessionStartModel } from "./ComputeSessionStart";
import { computeSourceLanguageForId } from "./computeSourceLanguage";
import type { ComputePanelSessions } from "./useComputePanelSessions";

const SCRIPT_NAME_ATTEMPTS = 50;

/** Runs typed code in this Console, starting its session the first time. */
export function useComputeConsoleRun(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly start: ComputeSessionStartModel;
  readonly model: ComputePanelSessions;
  readonly onSubmitted: (executionId: string) => void;
}) {
  const submit = useAtomCommand(computeEnvironment.submitExecution, { reportFailure: false });
  return async (code: string): Promise<boolean> => {
    const session: ComputeSessionRecord | null =
      input.model.liveSession ?? (await input.start.start());
    if (session === null) return false;
    const executionId = ComputeExecutionId.make(randomUUID());
    const result = await submit({
      environmentId: input.environmentId,
      input: {
        cwd: input.cwd,
        sessionId: session.sessionId,
        executionId,
        expectedGeneration: session.generation,
        code,
        source: { _tag: "console" },
      },
    });
    if (result._tag === "Success") {
      input.model.chooseSession(session.sessionId);
      input.model.refresh();
      input.onSubmitted(executionId);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) reportComputeFailure("Unable to run this code", result);
    return false;
  };
}

/** The box you type in: Shift+Enter runs, and Up and Down walk back through what you ran. */
export function ComputeConsoleInput(props: {
  readonly contextId: ComputeContextId;
  readonly language: string;
  readonly languageName: string;
  readonly history: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onRun: (code: string) => Promise<boolean>;
  readonly footer: ReactNode;
}) {
  const { contextId } = props;
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<ScientNestedCodeEditor | null>(null);
  const draft = useComputeConsoleStore((state) => state.drafts[contextId] ?? "");
  const initial = useRef({ code: draft, language: props.language });
  // Where Up has walked to, and what was being typed before it started.
  const browsing = useRef<{ readonly index: number; readonly typed: string } | null>(null);
  const setDraft = (code: string) => useComputeConsoleStore.getState().setDraft(contextId, code);
  const onChange = useStableCallback((code: string) => {
    browsing.current = null;
    setDraft(code);
  });
  const show = (code: string) => {
    setDraft(code);
    editor.current?.replaceExternalCode(code, props.language);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the CodeMirror editor into its host and owns its lifetime
  useLayoutEffect(() => {
    if (parent.current === null) return;
    const view = createScientNestedCodeEditor({
      parent: parent.current,
      code: initial.current.code,
      editable: true,
      language: initial.current.language,
      ariaLabel: "Console code",
      onUserCodeChange: onChange,
      onEscape: () => undefined,
    });
    editor.current = view;
    // An open Console is ready to type in, but never takes the keyboard from something typed in.
    const ready = requestAnimationFrame(() => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.isContentEditable || active.matches("input, textarea, select"));
      if (!typing) view.focusAt("end");
    });
    return () => {
      cancelAnimationFrame(ready);
      view.destroy();
      editor.current = null;
    };
  }, [onChange]);
  const language = props.language;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- CodeMirror holds its own language, which follows the runtime picked here
  useEffect(() => {
    const code = useComputeConsoleStore.getState().drafts[contextId] ?? "";
    editor.current?.replaceExternalCode(code, language);
  }, [contextId, language]);
  const run = useStableCallback(async () => {
    const code = useComputeConsoleStore.getState().drafts[contextId] ?? "";
    if (code.trim() === "" || props.disabled) return;
    browsing.current = null;
    show("");
    const ran = await props.onRun(code);
    // Starting can take a while: what failed comes back unless something new was typed.
    if (!ran && (useComputeConsoleStore.getState().drafts[contextId] ?? "") === "") show(code);
  });
  const walk = (step: -1 | 1) => {
    const { history } = props;
    const current = browsing.current;
    const index = (current?.index ?? history.length) + step;
    if (index < 0 || index > history.length || (current === null && step === 1)) return false;
    const typed = current?.typed ?? useComputeConsoleStore.getState().drafts[contextId] ?? "";
    show(index === history.length ? typed : (history[index] ?? ""));
    browsing.current = index === history.length ? null : { index, typed };
    return true;
  };
  return (
    <div className="rounded-[14px] border border-border bg-background">
      <div className="relative">
        {draft === "" ? (
          <span className="pointer-events-none absolute start-3 top-2.5 font-mono text-[13px] leading-[1.4] text-muted-foreground">
            Run {props.languageName}…
          </span>
        ) : null}
        <div
          ref={parent}
          role="application"
          className="max-h-60 min-h-10 min-w-0 overflow-y-auto px-2 py-1.5 text-[13px] [&_.cm-scroller]:font-mono! [&_.cm-scroller]:leading-[1.4]!"
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.stopPropagation();
              void run();
              return;
            }
            const edge =
              event.key === "ArrowUp" ? "start" : event.key === "ArrowDown" ? "end" : null;
            if (edge === null || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
              return;
            }
            if (editor.current?.caretAtEdge(edge) && walk(edge === "start" ? -1 : 1)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <div className="min-w-0">{props.footer}</div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Run"
          disabled={props.disabled || draft.trim() === ""}
          onClick={() => void run()}
        >
          <Play />
        </Button>
      </div>
    </div>
  );
}

/** Which language this Console runs. One Console holds one language, so another opens beside it. */
export function ComputeConsoleLanguage(props: {
  readonly start: ComputeSessionStartModel;
  readonly session: ComputeSessionRecord | null;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const { start, session } = props;
  const selected = start.selectedRuntime;
  const choices = start.readyRuntimes.map((runtime) => ({
    languageId: runtime.language.descriptor.languageId,
  }));
  const label = (runtime: NonNullable<typeof selected>) =>
    computeRuntimeChoiceLabel(
      {
        languageId: runtime.language.descriptor.languageId,
        languageName: runtime.language.descriptor.displayName,
        profile: runtime.candidate.profile,
      },
      choices,
    );
  const openConsole = (runtimeKey: string) => {
    const contextId = createComputeContextId();
    useComputeConsoleStore.getState().presetRuntime(contextId, runtimeKey);
    useRightPanelStore
      .getState()
      .openScient(props.threadRef, scientComputeSurface({ cwd: props.cwd, contextId }));
  };
  const languageId = session?.languageId ?? selected?.language.descriptor.languageId ?? null;
  const current = selected === null ? "" : label(selected);
  const mark =
    languageId === null ? null : (
      <ComputeLanguageLogo languageId={languageId} className="size-3.5 shrink-0" />
    );
  if (start.readyRuntimes.length < 2) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
        {mark}
        <span className="truncate">{current}</span>
      </span>
    );
  }
  return (
    <Select
      value={selected?.key ?? ""}
      onValueChange={(value) => {
        if (!value) return;
        if (session === null) start.selectRuntime(value);
        else if (value !== selected?.key) openConsole(value);
      }}
    >
      <SelectTrigger
        size="xs"
        variant="ghost"
        className="w-fit min-w-0 max-w-full"
        aria-label="Language"
      >
        {mark}
        <SelectValue className="max-w-52">{current}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {start.readyRuntimes.map((runtime) => (
          <SelectItem key={runtime.key} value={runtime.key} hideIndicator size="compact">
            <span className="flex items-center gap-1.5">
              <ComputeLanguageLogo
                languageId={runtime.language.descriptor.languageId}
                className="size-3.5 shrink-0"
              />
              {label(runtime)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The ways in for someone who has not found them yet; they go once something has run. */
export function ComputeConsoleLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly languageId: string | null;
}) {
  const { environmentId, cwd, threadRef, languageId } = props;
  const createDocument = useCreateNewDocument();
  const documentFiles = useNewDocumentFiles();
  const [picking, setPicking] = useState(false);
  const open = (relativePath: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  const extension =
    languageId === null ? undefined : computeSourceLanguageForId(languageId).extensions[0];
  const createScript = async () => {
    if (extension === undefined) return;
    const commands = documentFiles.commandsFor({ environmentId, cwd });
    for (let attempt = 1; attempt <= SCRIPT_NAME_ATTEMPTS; attempt += 1) {
      const name = attempt === 1 ? `script${extension}` : `script-${attempt}${extension}`;
      const created = await commands.create(name, "");
      if (created === "exists") continue;
      if (created !== null) open(name);
      return;
    }
  };
  const link =
    "cursor-pointer rounded-[4px] text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground";
  return (
    <div className="mt-3.5 flex flex-wrap justify-center gap-x-4 gap-y-1">
      <button
        type="button"
        className={link}
        onClick={() =>
          createDocument({
            format: "notebook",
            environmentId,
            cwd,
            base: "",
            open,
            ...(languageId === null ? {} : { notebookLanguage: languageId }),
          })
        }
      >
        New notebook
      </button>
      {extension === undefined ? null : (
        <button type="button" className={link} onClick={() => void createScript()}>
          New script
        </button>
      )}
      <button type="button" className={link} onClick={() => setPicking(true)}>
        Open a file
      </button>
      <CommandDialog open={picking} onOpenChange={setPicking}>
        {picking ? (
          <CommandDialogPopup
            aria-label="Open a file"
            padding="none"
            className="overflow-hidden"
            onBackdropPointerDown={() => setPicking(false)}
          >
            <ProjectFilePickerForTarget
              setOpen={setPicking}
              actionLabel="Open"
              target={{ environmentId, cwd, threadRef, projectName: "Project files" }}
              onSelectFile={open}
            />
          </CommandDialogPopup>
        ) : null}
      </CommandDialog>
    </div>
  );
}
