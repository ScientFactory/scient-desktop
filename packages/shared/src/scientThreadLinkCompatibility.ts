import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** Reads environment-qualified v1 links already stored in conversations and exports. */
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
