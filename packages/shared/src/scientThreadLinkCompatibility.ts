import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** Keeps a copied historical link bound to its recorded environment. */
export function formatEnvironmentQualifiedThreadLink(
  environmentId: string,
  threadId: string,
  title: string,
): string {
  const encodeSegment = (id: string) =>
    encodeURIComponent(id).replace(/\(/g, "%28").replace(/\)/g, "%29");
  const label =
    title
      .replace(/[[\]\\\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Untitled thread";
  return `[${label}](t3-thread://v1/${encodeSegment(environmentId)}/${encodeSegment(threadId)})`;
}

/** Reads environment-qualified links already stored in conversations and exports. */
export function parseEnvironmentQualifiedThreadLinkHref(
  href: string,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  const prefix = "t3-thread://v1/";
  if (!href.startsWith(prefix)) return null;
  const parts = href.slice(prefix.length).split("/");
  if (parts.length !== 2) return null;
  try {
    const environmentId = decodeEnvironmentId(decodeURIComponent(parts[0]!));
    const threadId = decodeThreadId(decodeURIComponent(parts[1]!));
    return Option.isSome(environmentId) && Option.isSome(threadId)
      ? { environmentId: environmentId.value, threadId: threadId.value }
      : null;
  } catch {
    return null;
  }
}
