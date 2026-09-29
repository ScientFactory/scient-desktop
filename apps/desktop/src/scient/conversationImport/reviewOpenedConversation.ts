// @effect-diagnostics nodeBuiltinImport:off -- explicit local-file review before the application runtime exists.
// @effect-diagnostics globalTimers:off -- a native-window-owned deadline before the Effect application runtime exists.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Electron from "electron";
import { conversationFileReviewHtml } from "./conversationFileReviewHtml.ts";
import {
  readLocalConversationPreview,
  LocalConversationPreviewError,
} from "./localConversationPreview.ts";

/** A local-only window. No normal application preload, persistent session, or server connection. */
export type ReviewedFileIdentity = Awaited<
  ReturnType<typeof readLocalConversationPreview>
>["identity"];

export async function reviewOpenedConversation(
  path: string,
  readOnly = false,
): Promise<ReviewedFileIdentity | null> {
  const abort = new AbortController();
  const window = new Electron.BrowserWindow({
    width: 680,
    height: 660,
    minWidth: 440,
    minHeight: 400,
    title: "Open conversation — Scient",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: NodePath.join(__dirname, "conversation-review-preload.cjs"),
      // Reuse one non-persistent, credential-free session. A new partition per
      // file would retain a Chromium session for every preview until app exit.
      partition: "scient-conversation-review",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("data:text/html;") });
  });
  const display = async (html: string) => {
    if (window.isDestroyed()) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            if (!window.isDestroyed()) window.destroy();
            reject(new Error("Conversation preview renderer timed out."));
          }, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (!window.isDestroyed()) window.show();
  };
  return new Promise<ReviewedFileIdentity | null>((resolve) => {
    let accepted = false;
    let ready = false;
    let identity: Awaited<ReturnType<typeof readLocalConversationPreview>>["identity"] | undefined;
    let confirming = false;
    const timeout = setTimeout(() => abort.abort(), 20_000);
    const onAction = (event: Electron.IpcMainEvent, action: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        return;
      if (action === "cancel") {
        window.close();
        return;
      }
      if (readOnly || action !== "continue" || !ready || !identity || confirming) return;
      confirming = true;
      void NodeFSP.lstat(path, { bigint: true })
        .then(async (stat) => {
          if (window.isDestroyed()) return;
          if (
            !stat.isFile() ||
            stat.dev.toString() !== identity!.dev ||
            stat.ino.toString() !== identity!.ino ||
            stat.size.toString() !== identity!.size ||
            stat.mtimeNs.toString() !== identity!.mtimeNs
          ) {
            ready = false;
            await display(
              conversationFileReviewHtml(
                null,
                "This file changed while you were reading it. Close this window and open the file again.",
              ),
            );
            return;
          }
          accepted = true;
          window.close();
        })
        .catch(() => {
          ready = false;
          void display(
            conversationFileReviewHtml(
              null,
              "This file is no longer available. Close this window and open it again.",
            ),
          ).catch(() => window.close());
        });
    };
    Electron.ipcMain.on("scient:conversation-review-action", onAction);
    window.once("closed", () => {
      abort.abort();
      clearTimeout(timeout);
      Electron.ipcMain.removeListener("scient:conversation-review-action", onAction);
      resolve(accepted ? (identity ?? null) : null);
    });
    window.webContents.once("render-process-gone", () => window.destroy());
    window.once("unresponsive", () => window.destroy());
    void (async () => {
      await display(conversationFileReviewHtml(null, undefined, readOnly));
      const preview = await readLocalConversationPreview(path, abort.signal);
      if (window.isDestroyed()) return;
      identity = preview.identity;
      clearTimeout(timeout);
      await display(conversationFileReviewHtml(preview, undefined, readOnly));
      ready = true;
    })().catch((cause: unknown) => {
      clearTimeout(timeout);
      if (!window.isDestroyed()) {
        if (
          cause instanceof LocalConversationPreviewError &&
          cause.reason === "unsupported-too-large" &&
          cause.identity
        ) {
          identity = cause.identity;
          const notice = conversationFileReviewHtml(
            {
              title: NodePath.basename(path),
              summary: "Preview size limit · File not yet fully validated",
              messages: [
                {
                  role: "Preview unavailable",
                  text: "This conversation is too large for a local preview. You can continue to import; Scient will check the complete file before creating a conversation.",
                },
              ],
              messageCount: 0,
              attachmentCount: 0,
              truncated: true,
            },
            undefined,
            readOnly,
          );
          void display(notice)
            .then(() => {
              ready = true;
            })
            .catch(() => window.close());
          return;
        }
        void display(
          conversationFileReviewHtml(
            null,
            "Scient could not safely preview this file. It may be damaged, unsupported, too large for a local preview, or unreadable.",
          ),
        ).catch(() => window.close());
      }
    });
  });
}
