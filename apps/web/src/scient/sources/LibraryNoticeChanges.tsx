import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { noticeChangesLine } from "./sourceLifecycleLabels";

type NoticeChanges = NonNullable<ScientSourcesOverviewResult["noticeChanges"]>;

/** One line for the notices the weekly check found since the person last dismissed it. */
export function LibraryNoticeChanges(props: {
  readonly changes: NoticeChanges;
  readonly onShow: (sourceIds: ReadonlyArray<string>) => void;
  /** Absent in a session that may not change the Library. */
  readonly onDismiss?: (() => void) | undefined;
}) {
  const line = noticeChangesLine(props.changes);
  if (!line) return null;
  return (
    <div className="mx-3 mt-2 flex items-start gap-2 text-xs text-muted-foreground">
      <div role="status" className="min-w-0 flex-1 break-words tabular-nums">
        {line}
      </div>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => props.onShow([...new Set(props.changes.map((change) => change.sourceId))])}
      >
        Show
      </Button>
      {props.onDismiss ? (
        <Button size="xs" variant="ghost" onClick={props.onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}
