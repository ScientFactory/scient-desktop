import { useEffectEvent } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FilePlus2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  ensureScientMarkdownDocumentPath,
  isScientMarkdownDocumentPath,
} from "../markdownDocumentPaths";

export function normalizeMarkdownCreatePath(input: string): string | null {
  let path = input.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path.length === 0 || path.length > 512 || path.startsWith("/")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  if (/\.[^./]+$/u.test(path) && !isScientMarkdownDocumentPath(path)) return null;
  path = ensureScientMarkdownDocumentPath(path);
  return path.length <= 512 ? path : null;
}

export function untitledMarkdownPath(selectedPath: string | null, collision = 1): string {
  const parent = selectedPath?.includes("/")
    ? selectedPath.slice(0, selectedPath.lastIndexOf("/"))
    : "";
  const fileName = collision === 1 ? "untitled.md" : `untitled-${collision}.md`;
  return parent ? `${parent}/${fileName}` : fileName;
}

function failureCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("failure" in cause)) return null;
  return typeof cause.failure === "string" ? cause.failure : null;
}

interface ScientMarkdownCreateButtonProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly selectedPath: string | null;
  readonly onCreated: (relativePath: string, contents: string, revision: string) => void;
}

export function ScientMarkdownCreateButton(props: ScientMarkdownCreateButtonProps) {
  const createFile = useCreateMarkdownFile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(() => untitledMarkdownPath(props.selectedPath));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [resetInputs, setResetInputs] = useState(() => ({ open, value: props.selectedPath }));
  if (resetInputs.open !== open || resetInputs.value !== props.selectedPath) {
    setResetInputs({ open, value: props.selectedPath });
    if (open) {
      setPath(untitledMarkdownPath(props.selectedPath));
      setError(null);
    }
  }
  const selectCreatePath = useEffectEvent((..._changes: readonly unknown[]) => {
    if (!open) return;
    queueMicrotask(() => inputRef.current?.select());
  });
  useEffect(() => selectCreatePath(open, props.selectedPath), [open, props.selectedPath]);

  const submit = () =>
    createMarkdownSubmit({ props, path, createFile, setError, setSubmitting, setOpen })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label="Create Markdown file"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            />
          }
        >
          <FilePlus2 />
        </TooltipTrigger>
        <TooltipPopup>Create Markdown file</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-72" side="bottom">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <PopoverTitle>New Markdown document</PopoverTitle>
          <Input
            ref={inputRef}
            aria-invalid={error !== null || undefined}
            aria-label="New Markdown file path"
            disabled={submitting}
            onChange={(event) => setPath(event.target.value)}
            size="compact"
            spellCheck={false}
            value={path}
          />
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button className="self-end" disabled={submitting} size="sm" type="submit">
            {submitting ? "Creating…" : "Create"}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function createMarkdownSubmit({
  props,
  path,
  createFile,
  setError,
  setSubmitting,
  setOpen,
}: {
  props: ScientMarkdownCreateButtonProps;
  path: string;
  createFile: ReturnType<typeof useCreateMarkdownFile>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return async () => {
    const normalized = normalizeMarkdownCreatePath(path);
    if (!normalized) {
      setError("Enter a relative Markdown path inside this workspace.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const contents = "";
    const isDefaultName = /(?:^|\/)untitled\.md$/u.test(normalized);
    const defaultParent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/") + 1)
      : "";
    try {
      for (let collision = 1; collision <= 100; collision += 1) {
        const candidate =
          isDefaultName && collision > 1 ? `${defaultParent}untitled-${collision}.md` : normalized;
        const result = await createFile({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            relativePath: candidate,
            contents,
            createOnly: true,
          },
        });
        if (result._tag === "Success") {
          setOpen(false);
          props.onCreated(result.value.relativePath, contents, result.value.revision);
          return;
        }
        if (result._tag !== "Failure") return;
        const cause = squashAtomCommandFailure(result);
        if (isDefaultName && failureCode(cause) === "path_exists") continue;
        setError(
          failureCode(cause) === "path_exists"
            ? "A file already exists at that path."
            : cause instanceof Error
              ? cause.message
              : "Unable to create the Markdown file.",
        );
        return;
      }
      setError("No available untitled filename was found in this folder.");
    } finally {
      setSubmitting(false);
    }
  };
}

function useCreateMarkdownFile() {
  return useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
}
