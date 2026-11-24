import {
  type EnvironmentId,
  type ProviderThreadId,
  requestedMcpSignInIsOpen,
  type ThreadId,
} from "@t3tools/contracts";

import { McpSignInAction } from "../../components/chat/McpSignInAction";
import { useEnvironmentSubscription } from "../../state/query";
import { threadMcpStatus } from "./extensionsState";

/**
 * The Sign in action on a row the agent asked for. It shows only while the chat's live session
 * still reports the server needs a sign-in, so an older row, a reload or another device never
 * offers a sign-in that was already done.
 */
export function RequestedMcpSignInAction(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly server: string;
  readonly noticeAt: number;
}) {
  const live = useEnvironmentSubscription(
    threadMcpStatus({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
  ).data;
  if (
    !requestedMcpSignInIsOpen(live, {
      server: props.server,
      providerThreadId: props.providerThreadId,
    })
  )
    return null;
  return <McpSignInAction {...props} />;
}
