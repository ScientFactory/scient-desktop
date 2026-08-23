import { DesktopAssetCopyRequestSchema, DesktopAssetCopyResultSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as DesktopAssetCopy from "../../scient/documentArtifacts/AssetCopy.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const saveAssetCopy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SAVE_ASSET_COPY_CHANNEL,
  payload: DesktopAssetCopyRequestSchema,
  result: DesktopAssetCopyResultSchema,
  handler: DesktopAssetCopy.saveAssetCopy,
});

const SavedAssetPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  // eslint-disable-next-line no-control-regex -- Native filesystem paths must reject NUL explicitly.
  Schema.isPattern(/^[^\0]+$/u),
);

export const revealSavedAsset = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_SAVED_ASSET_CHANNEL,
  payload: SavedAssetPath,
  result: Schema.Void,
  handler: DesktopAssetCopy.revealSavedAsset,
});
