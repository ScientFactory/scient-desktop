import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FilePenLine } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  RECOVERY_COPY_UNSETTLED,
  type RenameOpenDocumentResult,
} from "~/scient/markdownEditor/persistence/renameOpenDocument";

function renameFailureMessage(cause: unknown): string {
  const failure = failureCode(cause);
  return failure === "path_exists"
    ? "A file already exists at that path."
    : failure === "revision_conflict"
      ? "The file changed before it could be renamed. Reload it and try again."
      : cause instanceof Error
        ? cause.message
        : "Unable to rename the file.";
}

function failureCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("failure" in cause)) return null;
  return typeof cause.failure === "string" ? cause.failure : null;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * A typed destination as a workspace-relative path, or null when it is not
 * one. A name typed without an extension keeps the file's own. Spaces around
 * the typed text are dropped, as in every path field here: a name that truly
 * begins or ends with a space is rare, a stray one common.
 */
export function normalizeRenamePath(input: string, original: string): string | null {
  let path = input.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  const name = segments[segments.length - 1]!;
  // Windows cannot store a name that ends in a dot.
  if (name.endsWith(".")) return null;
  // A dotfile such as `.env` is a whole name, not an extension to add to.
  if (extension(path) === "" && !name.startsWith(".")) path += extension(original);
  return path.length <= 512 ? path : null;
}

interface FileRenameButtonProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /**
   * The revision the editor last read, checked by the server before renaming.
   * Null for a file the app cannot read whole (binary or truncated).
   */
  readonly revision: string | null;
  readonly disabled: boolean;
  /** Acquires the file's short clean-state barrier before dispatching the rename. */
  readonly beforeRename?: () => (() => void) | null;
  /** Narrows the destinations a file type accepts; the default keeps any path. */
  readonly normalize?: (input: string) => string | null;
  /** What to enter, when the default message does not fit the file type. */
  readonly invalidMessage?: string;
  /** A note under the field, for example what else refers to this file. */
  readonly notice?: ReactNode;
  /**
   * Before the ordinary rename: clears the file's recovery copy so it cannot
   * outlive the old name. A false result refuses the rename.
   */
  readonly prepareRename?: () => Promise<boolean>;
  readonly label: string;
  readonly onRenamed: (destinationRelativePath: string, revision: string) => void;
  /**
   * Renames the open document in place, keeping its editor. When it reports
   * `legacy-required`, the ordinary rename runs instead.
   */
  readonly moveInPlace?: (destinationRelativePath: string) => Promise<RenameOpenDocumentResult>;
}

/** The open file's name, which renames the file when clicked. */
export function FileRenameButton(props: FileRenameButtonProps) {
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
      // The name is selected, not its extension, so typing keeps the file type.
      const slash = props.relativePath.lastIndexOf("/");
      const dot = props.relativePath.lastIndexOf(".");
      input.setSelectionRange(slash + 1, dot > slash + 1 ? dot : props.relativePath.length);
    });
  }, [open, props.relativePath]);

  const submit = async () => {
    if (props.disabled || submitting) return;
    // The field starts as the file's exact path. Submitting it untouched is not
    // a rename, even when normalizing it as typed text would alter it.
    if (path === props.relativePath) {
      setOpen(false);
      return;
    }
    const destinationRelativePath = props.normalize
      ? props.normalize(path)
      : normalizeRenamePath(path, props.relativePath);
    if (!destinationRelativePath) {
      setError(props.invalidMessage ?? "Enter a relative path inside this workspace.");
      return;
    }
    if (destinationRelativePath === props.relativePath) {
      setOpen(false);
      return;
    }
    if (props.moveInPlace) {
      setSubmitting(true);
      setError(null);
      let outcome: RenameOpenDocumentResult;
      try {
        outcome = await props.moveInPlace(destinationRelativePath);
      } catch (cause) {
        outcome = { kind: "failed", cause };
      } finally {
        setSubmitting(false);
      }
      if (outcome.kind === "failed") {
        setError(renameFailureMessage(outcome.cause));
        return;
      }
      if (outcome.kind !== "legacy-required") {
        setOpen(false);
        return;
      }
    }
    if (props.prepareRename && !(await props.prepareRename())) {
      setError(RECOVERY_COPY_UNSETTLED);
      return;
    }
    const release = props.beforeRename?.();
    if (props.beforeRename && !release) {
      setError("Finish the current file operation before renaming.");
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
          ...(props.revision === null ? {} : { expectedRevision: props.revision }),
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
              : "Unable to rename the file.",
      );
    } finally {
      release?.();
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
            className="group/file-name -mx-1 inline-flex max-w-48 items-center gap-1 rounded-sm px-1 py-0.5 font-medium text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-70"
            disabled={props.disabled}
          >
            <span className="truncate">{props.label}</span>
            <FilePenLine
              aria-hidden
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover/file-name:opacity-70 group-focus-visible/file-name:opacity-70"
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
          <PopoverTitle>Rename file</PopoverTitle>
          <Input
            ref={inputRef}
            aria-invalid={error !== null || undefined}
            aria-label="File path"
            disabled={submitting}
            onChange={(event) => setPath(event.target.value)}
            size="compact"
            spellCheck={false}
            value={path}
          />
          {props.notice ? (
            <div className="text-xs text-muted-foreground">{props.notice}</div>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            className="self-end"
            disabled={submitting || props.disabled}
            size="sm"
            type="submit"
          >
            {submitting ? "Renaming…" : "Rename"}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
