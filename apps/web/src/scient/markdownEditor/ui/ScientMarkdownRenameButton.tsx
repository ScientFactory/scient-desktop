import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FilePenLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { normalizeMarkdownCreatePath } from "./ScientMarkdownCreateButton";

function failureCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("failure" in cause)) return null;
  return typeof cause.failure === "string" ? cause.failure : null;
}

interface ScientMarkdownRenameButtonProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly revision: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onRenamed: (destinationRelativePath: string, revision: string) => void;
}

export function ScientMarkdownRenameButton(props: ScientMarkdownRenameButtonProps) {
  const renameFile = useAtomCommand(projectEnvironment.renameFile, { reportFailure: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(props.relativePath);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(props.relativePath);
    setError(null);
    queueMicrotask(() => {
      const input = inputRef.current;
      if (!input) return;
      const slash = props.relativePath.lastIndexOf("/");
      const dot = props.relativePath.lastIndexOf(".");
      input.setSelectionRange(slash + 1, dot > slash ? dot : props.relativePath.length);
    });
  }, [open, props.relativePath]);

  const submit = async () => {
    const destinationRelativePath = normalizeMarkdownCreatePath(path);
    if (!destinationRelativePath) {
      setError("Enter a relative Markdown path inside this workspace.");
      return;
    }
    if (destinationRelativePath === props.relativePath) {
      setOpen(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await renameFile({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          relativePath: props.relativePath,
          destinationRelativePath,
          expectedRevision: props.revision,
        },
      });
      if (result._tag === "Success") {
        setOpen(false);
        props.onRenamed(result.value.destinationRelativePath, result.value.revision);
        return;
      }
      if (result._tag !== "Failure") return;
      const cause = squashAtomCommandFailure(result);
      const failure = failureCode(cause);
      setError(
        failure === "path_exists"
          ? "A file already exists at that path."
          : failure === "revision_conflict"
            ? "The file changed before it could be renamed. Reload it and try again."
            : cause instanceof Error
              ? cause.message
              : "Unable to rename the Markdown file.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={props.disabled}
        render={
          <button
            type="button"
            aria-label={`Rename ${props.label}`}
            className="group/markdown-filename -mx-1 inline-flex max-w-48 items-center gap-1 rounded-sm px-1 py-0.5 font-medium text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70"
            disabled={props.disabled}
          >
            <span className="truncate">{props.label}</span>
            <FilePenLine
              aria-hidden
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover/markdown-filename:opacity-70 group-focus-visible/markdown-filename:opacity-70"
            />
          </button>
        }
      />
      <PopoverPopup align="end" className="w-80" side="bottom">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <PopoverTitle className="text-sm">Rename Markdown document</PopoverTitle>
          <Input
            ref={inputRef}
            aria-invalid={error !== null || undefined}
            aria-label="Markdown file path"
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
            {submitting ? "Renaming…" : "Rename"}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
