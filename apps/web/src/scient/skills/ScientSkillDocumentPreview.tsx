import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useEnvironmentQuery } from "~/state/query";

import { scientSkillDocument } from "./scientSkillsState";

export function ScientSkillDocumentPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly releaseKey: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const document = useEnvironmentQuery(
    scientSkillDocument({
      environmentId: props.environmentId,
      input: { releaseKey: props.releaseKey },
    }),
  );

  if (document.error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {document.error}
      </div>
    );
  }
  if (document.data === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading skill…
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background">
      <ChatMarkdown
        text={document.data.instructions}
        cwd={undefined}
        threadRef={props.threadRef}
        contentDirection="auto"
        className="mx-auto max-w-4xl px-6 py-5"
      />
    </div>
  );
}
