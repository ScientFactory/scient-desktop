const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );

export interface ConversationFileReviewContent {
  readonly title: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly messageCount: number;
  readonly attachmentCount: number;
  readonly truncated: boolean;
  readonly summary?: string;
}

/** No executable document markup, external assets, links or application credentials. */
export function conversationFileReviewHtml(
  content: ConversationFileReviewContent | null,
  error?: string,
  readOnly = false,
): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark"><title>Open conversation — Scient</title>
<style>
*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText;font:15px/1.55 system-ui,sans-serif}
header{padding:24px 28px 16px;border-bottom:1px solid color-mix(in srgb,CanvasText 16%,transparent)}
h1{font-size:23px;line-height:1.25;margin:0 0 8px;overflow-wrap:anywhere}p{margin:8px 0;color:GrayText}
main{height:calc(100vh - 235px);min-height:150px;overflow:auto;padding:12px 28px}
article{padding:16px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}
article h2{font-size:14px;margin:0 0 8px}article div{white-space:pre-wrap;overflow-wrap:anywhere;unicode-bidi:plaintext}
footer{padding:16px 28px;border-top:1px solid color-mix(in srgb,CanvasText 16%,transparent)}
footer p{font-size:13px;margin:0 0 12px}.actions{display:flex;justify-content:flex-end;gap:10px}
button{font:inherit;border-radius:8px;border:1px solid GrayText;padding:7px 16px;background:Canvas;color:CanvasText;cursor:pointer}
button.primary{background:Highlight;color:HighlightText;border-color:Highlight}button:focus-visible{outline:2px solid Highlight;outline-offset:3px}
</style></head><body><header><h1>${escapeHtml(content?.title ?? "Open conversation")}</h1>
<p>${content ? escapeHtml(content.summary ?? `${content.messageCount} messages · ${content.attachmentCount} attachments · Unverified file`) : error ? "Unable to preview this conversation" : "Checking this file locally…"}</p></header>
<main aria-label="Conversation preview" tabindex="0">${
    content
      ? content.messages
          .map(
            (message) =>
              `<article><h2>${escapeHtml(message.role)}</h2><div dir="auto">${escapeHtml(message.text)}</div></article>`,
          )
          .join("") +
        (content.truncated
          ? "<p>Preview shortened. Import checks the complete conversation.</p>"
          : "")
      : `<p role="status">${escapeHtml(error ?? "Nothing is imported or sent to a server while you preview.")}</p>`
  }</main>
<footer><p>${readOnly ? "Read-only preview. Nothing is imported or sent to a server." : content ? "Continue to choose where to import. No agent runs automatically." : "Close this window to leave your workspace unchanged."}</p>
<div class="actions"><button id="cancel">${readOnly ? "Close" : "Cancel"}</button>${content && !readOnly ? '<button id="continue" class="primary">Continue to import</button>' : ""}</div></footer></body></html>`;
}
