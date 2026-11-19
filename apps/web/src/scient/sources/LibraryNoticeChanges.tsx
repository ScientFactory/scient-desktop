import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { Button } from "../../components/ui/button";
import type { SourcesActivityItem } from "./sourcesFeedback";
import { noticeChangesLine } from "./sourceLifecycleLabels";

type NoticeChanges = NonNullable<ScientSourcesOverviewResult["noticeChanges"]>;

interface NoticeChangesProps {
  readonly changes: NoticeChanges;
  readonly onShow: (sourceIds: ReadonlyArray<string>) => void;
  /** Absent in a session that may not change the Library. */
  readonly onDismiss?: (() => void) | undefined;
}

/** The notices the weekly check found since the person last dismissed it, with Show. */
function LibraryNoticeChanges(props: NoticeChangesProps) {
  const resolve = useMessages();
  const line = noticeChangesLine(props.changes, resolve);
  if (!line) return null;
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      <div role="status" className="min-w-0 flex-1 break-words tabular-nums">
        {line}
      </div>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => props.onShow([...new Set(props.changes.map((change) => change.sourceId))])}
      >
        <T context="verb, button">Show</T>
      </Button>
      {props.onDismiss ? (
        <Button size="xs" variant="ghost" onClick={props.onDismiss}>
          <T>Dismiss</T>
        </Button>
      ) : null}
    </div>
  );
}

/** Worth knowing, never blocking: it leaves Activity once dismissed. */
export function libraryNoticeChangesActivity(
  props: NoticeChangesProps,
  resolve: MessageResolver = m,
): SourcesActivityItem | null {
  const line = noticeChangesLine(props.changes, resolve);
  if (!line) return null;
  return {
    key: "notice-changes",
    tone: "advisory",
    label: line,
    body: <LibraryNoticeChanges {...props} />,
  };
}
