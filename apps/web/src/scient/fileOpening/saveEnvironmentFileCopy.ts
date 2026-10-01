import { type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  AssetCreateUrlResult,
  AssetResource,
  DesktopAssetCopyResult,
  EnvironmentId,
} from "@t3tools/contracts";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { ensureLocalApi } from "~/localApi";

import { environmentFileAssetResource } from "./openEnvironmentFileInPreview";

/**
 * Saves a copy of any file the environment can read onto the device in hand:
 * the native Save dialog on desktop, a download in a browser. It is what
 * "open it in another app" means for a viewer on another machine, where the
 * host's own applications are out of reach, and it works for files Scient
 * cannot preview. The environment serves the one exact file, nothing beside it.
 */
export async function saveEnvironmentFileCopy<AssetError>(input: {
  readonly environmentId: EnvironmentId;
  /** Absolute path on the environment that owns the file. */
  readonly path: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
}): Promise<DesktopAssetCopyResult> {
  const asset = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: { resource: environmentFileAssetResource({ path: input.path, access: "exact" }) },
  });
  if (asset._tag === "Failure") return { _tag: "failed", reason: "source-unavailable" };
  const url = resolveAssetUrl(input.httpBaseUrl, asset.value.relativeUrl);
  if (url === null) return { _tag: "failed", reason: "source-unavailable" };
  return ensureLocalApi().documents.saveAssetCopy({
    url,
    suggestedFileName: fileNameOf(asset.value.sourcePath ?? input.path),
  });
}

function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || "file";
}

export interface FileCopyNotice {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
}

/**
 * What to tell the person after a save. A cancelled dialog needs no message.
 * A browser download is only known to have started; the desktop dialog knows
 * the copy was written.
 */
export function fileCopyNotice(result: DesktopAssetCopyResult): FileCopyNotice | null {
  switch (result._tag) {
    case "saved":
      return { type: "success", title: "Copy saved" };
    case "download-started":
      return { type: "success", title: "Download started" };
    case "cancelled":
      return null;
    case "failed":
      switch (result.reason) {
        case "dialog-failed":
          return { type: "error", title: "The Save dialog could not be opened" };
        case "source-unavailable":
          return {
            type: "error",
            title: "This file is no longer available",
            description: "It may have been moved, renamed, or deleted, or it can't be read.",
          };
        case "source-changed":
          return {
            type: "error",
            title: "The file changed before it could be saved",
            description: "Try saving again.",
          };
        case "network-failed":
          return {
            type: "error",
            title: "The file could not be downloaded",
            description: "Check the environment connection and try again.",
          };
        case "write-failed":
          return {
            type: "error",
            title: "The copy could not be saved",
            description: "Choose another location or check its permissions.",
          };
      }
  }
}
