import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

import { ScientTooltip } from "../presentation/ScientTooltip";

type StoreIssue = NonNullable<ScientSourcesOverviewResult["unreadableRecords"]>[number];

/** One quiet line when some record files could not be read; the rest of the Library still lists. */
export function SourceStoreNotice(props: { readonly unreadable: ReadonlyArray<StoreIssue> }) {
  if (props.unreadable.length === 0) return null;
  const count = props.unreadable.length;
  return (
    <div className="mx-3 mt-2 text-xs text-muted-foreground">
      <ScientTooltip
        content={
          <ul className="space-y-1">
            {props.unreadable.map((issue) => (
              <li key={issue.path}>
                <span className="font-mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        }
      >
        <span tabIndex={0}>
          {count === 1
            ? "1 source file could not be read and is not listed."
            : `${count} source files could not be read and are not listed.`}
        </span>
      </ScientTooltip>
    </div>
  );
}
