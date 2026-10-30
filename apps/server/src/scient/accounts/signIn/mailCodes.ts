import { codeInText } from "./messageCodes.ts";

/** Gmail's feed of unread mail, read with the session already in the browser profile. */
export const MAIL_FEED_URL = "https://mail.google.com/mail/feed/atom";

/** Reads the feed as the page shows it, so no cookie leaves the browser. */
export const mailFeedScript = "document.documentElement.outerHTML";

const unescape = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const tag = (entry: string, name: string) =>
  new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "iu").exec(entry)?.[1];

/** The newest code among mail that arrived after the sign-in began. */
export function codeInMailFeed(feed: string, sinceMs: number) {
  for (const [entry] of feed.matchAll(/<entry>[\s\S]*?<\/entry>/giu)) {
    const issued = Date.parse(tag(entry, "issued") ?? tag(entry, "modified") ?? "");
    if (!(issued >= sinceMs)) continue;
    const text = unescape(`${tag(entry, "title") ?? ""} ${tag(entry, "summary") ?? ""}`);
    const code = codeInText(text);
    if (code !== undefined) return code;
  }
  return undefined;
}
