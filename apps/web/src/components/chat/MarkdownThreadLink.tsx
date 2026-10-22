import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatEnvironmentQualifiedThreadLink,
  formatThreadLink,
  percentDecodedThreadLinkId,
  resolveThreadLinkRef,
} from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { ThreadContextChip } from "../ThreadContextChip";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly environmentQualified?: boolean;
}) {
  const decodedId = props.environmentQualified ? null : percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const refs = useThreadRefs(local === null);
  const remote = useThreadShell(
    local === null
      ? resolveThreadLinkRef(scopeThreadRef(props.environmentId, props.threadId), refs)
      : null,
  );
  const thread = local ?? remote;
  const environmentId = thread?.environmentId ?? props.environmentId;
  const threadId = thread?.id ?? props.threadId;
  const title = thread?.title.trim() || props.label;
  return (
    <ThreadContextChip
      record={{ environmentId, threadId, title: props.label }}
      // SCIENT-FORK:START — copied legacy links preserve cross-environment identity.
      copyMarkdown={
        props.environmentQualified
          ? formatEnvironmentQualifiedThreadLink(props.environmentId, threadId, title)
          : formatThreadLink(threadId, title)
      }
      // SCIENT-FORK:END
    />
  );
}
