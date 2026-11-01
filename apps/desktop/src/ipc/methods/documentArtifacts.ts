import {
  DesktopAssetCopyRequestSchema,
  DesktopAssetCopyResultSchema,
  DesktopPdfBytesCopyRequestSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as DesktopAssetCopy from "../../scient/documentArtifacts/AssetCopy.ts";
import * as DocumentPageIpc from "../../scient/documentExport/documentPageIpc.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const saveAssetCopy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SAVE_ASSET_COPY_CHANNEL,
  payload: DesktopAssetCopyRequestSchema,
  result: DesktopAssetCopyResultSchema,
  handler: DesktopAssetCopy.saveAssetCopy,
});

export const savePdfBytesCopy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SAVE_PDF_BYTES_COPY_CHANNEL,
  payload: DesktopPdfBytesCopyRequestSchema,
  result: DesktopAssetCopyResultSchema,
  handler: DesktopAssetCopy.savePdfBytesCopy,
});

const SavedAssetPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\x00]+$/u),
);

export const revealSavedAsset = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_SAVED_ASSET_CHANNEL,
  payload: SavedAssetPath,
  result: Schema.Void,
  handler: DesktopAssetCopy.revealSavedAsset,
});

export const renderDocumentPagePdf = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RENDER_DOCUMENT_PAGE_PDF_CHANNEL,
  ...DocumentPageIpc.renderDocumentPagePdfSchemas,
  handler: DocumentPageIpc.renderDocumentPagePdf,
});
