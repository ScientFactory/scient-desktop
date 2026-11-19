import { CONVERSATION_REFERENCE_URL_PREFIX, type ConversationMessage } from "@t3tools/contracts";
import { importedMessageMarkdown } from "@scientfactory/conversation";

export interface SnapshotRepository {
  readonly webUrl: string;
  readonly commit: string;
}

const FILE_LINE = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/u;

/** A GitHub link to a project-relative file at the shared commit, or null when there is none. */
export function repositoryFileUrl(
  repository: SnapshotRepository | undefined,
  href: string,
): string | null {
  if (repository === undefined) return null;
  let base: URL;
  try {
    base = new URL(repository.webUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.hostname !== "github.com") return null;
  const match = FILE_LINE.exec(href.trim());
  const path = (match?.[1] ?? "").replace(/^\.\//u, "");
  const line = match?.[2] ?? match?.[3];
  // Absolute and home paths point outside the repository, or at a root the reader can't see.
  if (path === "" || /^(?:[a-z][a-z0-9+.-]*:|\/|~|\\|[A-Za-z]:)/iu.test(path)) return null;
  if (path.split("/").some((segment) => segment === "..")) return null;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base.origin}${base.pathname.replace(/\/+$/u, "")}/blob/${encodeURIComponent(repository.commit)}/${encoded}${line ? `#L${line}` : ""}`;
}

const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(([^()\s]+)\)/gu;

function isWebHref(href: string): boolean {
  return /^(?:https?:|mailto:|#)/iu.test(href);
}

/**
 * Message Markdown for a reader without the original computer: typed references become readable
 * text, and links to project files open on GitHub at the shared commit or show as plain code.
 */
export function readerMessageMarkdown(
  message: ConversationMessage,
  repository: SnapshotRepository | undefined,
): string {
  const mentions = new Map(
    message.references.flatMap((reference) =>
      reference._tag === "mention" ? [[reference.id, reference.path] as const] : [],
    ),
  );
  const withMentions =
    mentions.size === 0
      ? message
      : {
          ...message,
          text: message.text.replace(MARKDOWN_LINK, (whole, bang: string, label, href: string) => {
            if (bang !== "" || !href.startsWith(CONVERSATION_REFERENCE_URL_PREFIX)) return whole;
            const path = mentions.get(href.slice(CONVERSATION_REFERENCE_URL_PREFIX.length));
            const url = path === undefined ? null : repositoryFileUrl(repository, path);
            return url === null ? whole : `[\`${path}\`](${url})`;
          }),
        };
  return importedMessageMarkdown(withMentions).replace(
    MARKDOWN_LINK,
    (whole, bang: string, label: string, href: string) => {
      if (bang !== "" || isWebHref(href)) return whole;
      const url = repositoryFileUrl(repository, decodeURIComponentSafe(href));
      if (url !== null) return `[${label}](${url})`;
      return label.trim() === "" ? "" : `\`${label.replaceAll("`", "")}\``;
    },
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
