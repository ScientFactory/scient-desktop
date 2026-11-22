import type { DesktopFeedbackBridge } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import * as IpcChannels from "../../ipc/channels.ts";

/** Keep Scient feedback preload behavior out of T3's inherited preload. */
export function makeDesktopFeedbackBridge(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): DesktopFeedbackBridge {
  return {
    prepare: () => ipcRenderer.invoke(IpcChannels.FEEDBACK_PREPARE_CHANNEL),
    captureScreenshot: () => ipcRenderer.invoke(IpcChannels.FEEDBACK_CAPTURE_SCREENSHOT_CHANNEL),
    readRecentLogs: () => ipcRenderer.invoke(IpcChannels.FEEDBACK_READ_RECENT_LOGS_CHANNEL),
    submit: (request) => ipcRenderer.invoke(IpcChannels.FEEDBACK_SUBMIT_CHANNEL, request),
    takeFixedNotices: () => ipcRenderer.invoke(IpcChannels.FEEDBACK_TAKE_FIXED_NOTICES_CHANNEL),
  };
}
