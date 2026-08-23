import { DesktopAssetCopyRequestSchema, DesktopAssetCopyResultSchema } from "@t3tools/contracts";

import * as DesktopAssetCopy from "../../scient/documentArtifacts/AssetCopy.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const saveAssetCopy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SAVE_ASSET_COPY_CHANNEL,
  payload: DesktopAssetCopyRequestSchema,
  result: DesktopAssetCopyResultSchema,
  handler: DesktopAssetCopy.saveAssetCopy,
});
