import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "~/hooks/useCopyToClipboard";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";

import { isAbsolutePath } from "~/terminal-links";

import { stackedThreadToast, toastManager } from "../ui/toast";

export type FilePathCopyFormat = "relative" | "full";

const isClipboardApiUnavailableError = Schema.is(ClipboardApiUnavailableError);
const isClipboardWriteError = Schema.is(ClipboardWriteError);

export function filePathCopyTitle(format: FilePathCopyFormat): "Relative path" | "Full path" {
  return format === "relative" ? "Relative path" : "Full path";
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (isWindowsAbsolutePath(workspaceRoot)) {
    const root = workspaceRoot.replace(/[\\/]+$/u, "");
    const path = relativePath.replace(/^[\\/]+/u, "").replaceAll("/", "\\");
    return `${root}\\${path}`;
  }
  return `${workspaceRoot.replace(/\/+$/u, "")}/${relativePath.replace(/^\/+/u, "")}`;
}

/**
 * Where a file tab's path points. A files-panel surface stores a
 * workspace-relative path, the absolute path of a host file outside the
 * workspace, or an attachment name that is no filesystem path at all.
 */
export type FileSurfacePath =
  | { readonly kind: "workspace"; readonly relativePath: string }
  | { readonly kind: "host"; readonly absolutePath: string };

/** Classifies a file surface the same way the files panel decides it is a host file. */
export function fileSurfacePath(surface: {
  readonly relativePath: string;
  readonly attachment?: unknown;
}): FileSurfacePath | null {
  if (surface.attachment !== undefined) return null;
  return isAbsolutePath(surface.relativePath)
    ? { kind: "host", absolutePath: surface.relativePath }
    : { kind: "workspace", relativePath: surface.relativePath };
}

/** The copy actions a path supports: a host file has no workspace-relative form. */
export function filePathCopyFormats(path: FileSurfacePath | null): readonly FilePathCopyFormat[] {
  if (path === null) return [];
  return path.kind === "workspace" ? ["relative", "full"] : ["full"];
}

export function resolveFilePathCopyValue(input: {
  readonly path: FileSurfacePath;
  readonly workspaceRoot: string | null | undefined;
  readonly format: FilePathCopyFormat;
}): string | null {
  if (input.path.kind === "host") {
    return input.format === "full" ? input.path.absolutePath : null;
  }
  if (input.format === "relative") return input.path.relativePath;
  if (!input.workspaceRoot) return null;
  return joinWorkspacePath(input.workspaceRoot, input.path.relativePath);
}

function filePathCopyErrorDescription(error: unknown): string {
  if (isClipboardApiUnavailableError(error)) {
    return "Clipboard API unavailable.";
  }
  if (isClipboardWriteError(error)) {
    return error.cause instanceof Error ? error.cause.message : "An error occurred.";
  }
  return error instanceof Error ? error.message : "An error occurred.";
}

export async function copyFilePathToClipboard(input: {
  readonly value: string;
  readonly format: FilePathCopyFormat;
  readonly onError?: (error: unknown) => void;
}): Promise<boolean> {
  const title = filePathCopyTitle(input.format);
  try {
    const copied = await writeTextToClipboard(input.value, title.toLowerCase());
    if (!copied) return false;
    toastManager.add({
      type: "success",
      title: `${title} copied`,
      description: input.value,
    });
    return true;
  } catch (error) {
    input.onError?.(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Failed to copy ${title.toLowerCase()}`,
        description: filePathCopyErrorDescription(error),
      }),
    );
    return false;
  }
}
