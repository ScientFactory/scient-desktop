import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "~/hooks/useCopyToClipboard";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";

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

export function resolveFilePathCopyValue(input: {
  readonly relativePath: string;
  readonly workspaceRoot: string | null | undefined;
  readonly format: FilePathCopyFormat;
}): string | null {
  if (input.format === "relative") return input.relativePath;
  if (!input.workspaceRoot) return null;
  return joinWorkspacePath(input.workspaceRoot, input.relativePath);
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
