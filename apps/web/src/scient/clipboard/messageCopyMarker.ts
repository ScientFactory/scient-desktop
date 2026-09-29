/** Marks the Copy message button's HTML so Scient's own editors can keep pasting its Markdown. */
export const MESSAGE_COPY_ATTRIBUTE = "data-scient-message-copy";
const MESSAGE_COPY_PATTERN = new RegExp(`<div\\s[^>]*\\b${MESSAGE_COPY_ATTRIBUTE}\\b`, "u");

export function isScientMessageCopyHtml(html: string): boolean {
  return MESSAGE_COPY_PATTERN.test(html);
}
