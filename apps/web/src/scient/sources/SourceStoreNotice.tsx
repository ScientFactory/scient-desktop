import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

import type { SourcesActivityItem } from "./sourcesFeedback";

type StoreIssue = NonNullable<ScientSourcesOverviewResult["unreadableRecords"]>[number];

const unreadableLine = (count: number) =>
  count === 1
    ? "1 source file could not be read and is not listed."
    : `${count} source files could not be read and are not listed.`;

/** The record files that could not be read, each with its reason; the rest still lists. */
export function SourceStoreNotice(props: { readonly unreadable: ReadonlyArray<StoreIssue> }) {
  if (props.unreadable.length === 0) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>{unreadableLine(props.unreadable.length)}</p>
      <ul className="space-y-1">
        {props.unreadable.map((issue) => (
          <li key={issue.path} className="break-words">
            <span className="font-mono">{issue.path}</span>: {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stays in Activity while the overview reports the files, so until they read again. */
export function sourceStoreActivity(
  unreadable: ReadonlyArray<StoreIssue>,
): SourcesActivityItem | null {
  if (unreadable.length === 0) return null;
  return {
    key: "unreadable-records",
    tone: "error",
    label: unreadableLine(unreadable.length),
    body: <SourceStoreNotice unreadable={unreadable} />,
  };
}
