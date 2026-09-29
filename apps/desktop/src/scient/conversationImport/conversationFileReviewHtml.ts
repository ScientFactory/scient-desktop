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

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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
  const summary = content
    ? escapeHtml(
        content.summary ??
          `${plural(content.messageCount, "message")} · ${plural(content.attachmentCount, "attachment")} · Unverified file`,
      )
    : error
      ? "Unable to preview this conversation"
      : "Checking this file…";
  const messages = content
    ? content.messages
        .map(
          (message) =>
            `<article><h2>${escapeHtml(message.role)}</h2><div dir="auto">${escapeHtml(message.text)}</div></article>`,
        )
        .join("") +
      (content.truncated
        ? "<p>Preview shortened. Import checks the complete conversation.</p>"
        : "")
    : `<p role="status">${escapeHtml(error ?? "Nothing is imported or sent to a server while you preview.")}</p>`;
  // Opening a file is a compact confirmation; reading is an optional disclosure
  // that asks the window to grow. A read-only preview shows the messages directly.
  const body = readOnly
    ? `<main aria-label="Conversation preview" tabindex="0">${messages}</main>`
    : content
      ? `<details id="read"><summary>Read conversation</summary><main aria-label="Conversation preview" tabindex="0">${messages}</main></details>`
      : `<main>${messages}</main>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark"><title>Open conversation — Scient</title>
<style>
*{box-sizing:border-box}html,body{height:100%}body{margin:0;padding:20px 22px 18px;display:flex;flex-direction:column;gap:10px;background:Canvas;color:CanvasText;font:14px/1.5 system-ui,sans-serif}
h1{font-size:18px;line-height:1.3;margin:0;overflow-wrap:anywhere}p{margin:0;color:GrayText}
details{display:flex;flex-direction:column;flex:1;min-height:0}details[open]{flex:1}
summary{cursor:pointer;color:GrayText;font-size:13px;width:max-content}summary:hover{color:CanvasText}
main{flex:1;min-height:0;overflow:auto}details main{margin-top:8px}
article{padding:10px 0;border-top:1px solid color-mix(in srgb,CanvasText 10%,transparent)}
article h2{font-size:12px;margin:0 0 4px;color:GrayText;text-transform:uppercase;letter-spacing:.04em}article div{white-space:pre-wrap;overflow-wrap:anywhere;unicode-bidi:plaintext}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:auto;padding-top:6px}
button{font:inherit;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);padding:6px 14px;background:Canvas;color:CanvasText;cursor:pointer}
button.primary{background:Highlight;color:HighlightText;border-color:Highlight}button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
</style></head><body><h1>${escapeHtml(content?.title ?? "Open conversation")}</h1><p>${summary}</p>${body}
<div class="actions"><button id="cancel">${readOnly ? "Close" : "Cancel"}</button>${content && !readOnly ? '<button id="continue" class="primary">Import…</button>' : ""}</div></body></html>`;
}
