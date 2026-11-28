import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

/** The conversation an Activity entry or agent change came from, by its title. */
export function activityConversation(
  entry: { readonly threadId?: ThreadId | undefined },
  environmentId: EnvironmentId,
  resolve: MessageResolver = m,
) {
  if (!entry.threadId) return undefined;
  if (entry.threadId === ThreadId.make("scient-accounts-check"))
    return resolve(msg("Check my accounts"));
  if (entry.threadId === ThreadId.make("scient-paper-get")) return resolve(msg("Get PDF"));
  return appAtomRegistry.get(
    environmentThreadShells.threadShellAtom({ environmentId, threadId: entry.threadId }),
  )?.title;
}
