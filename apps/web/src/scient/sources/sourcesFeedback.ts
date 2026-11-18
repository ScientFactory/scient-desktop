import type { ScientSourceImportOperation } from "@t3tools/contracts";
import { msg } from "gt-react";
import type { ReactNode } from "react";

import { m, type MessageResolver } from "~/i18n/messages";

import type { ImportPreparation } from "./sourcesWorkflow";

/** Running work, then what needs the person: an error, a choice, or something worth knowing. */
export type SourcesActivityTone = "running" | "error" | "decision" | "advisory";

export interface SourcesActivityItem {
  readonly key: string;
  readonly tone: SourcesActivityTone;
  /** A few words for the Activity button's summary, such as "Backing up the Library". */
  readonly label: string;
  /** The item in the Activity dialog, with its own actions. */
  readonly body: ReactNode;
}

export interface SourcesActivity {
  readonly running: ReadonlyArray<SourcesActivityItem>;
  /** Errors first, then choices, then the rest; each kind in the order given. */
  readonly issues: ReadonlyArray<SourcesActivityItem>;
  readonly count: number;
  /** The running work in one line, or null when nothing runs. */
  readonly summary: string | null;
}

const ISSUE_RANK: Record<Exclude<SourcesActivityTone, "running">, number> = {
  error: 0,
  decision: 1,
  advisory: 2,
};

/** What the Activity button counts and its dialog lists; absent items are skipped. */
export function selectSourcesActivity(
  items: ReadonlyArray<SourcesActivityItem | null | undefined | false>,
): SourcesActivity {
  const present = items.filter((item): item is SourcesActivityItem => Boolean(item));
  const running = present.filter((item) => item.tone === "running");
  const issues = present
    .flatMap((item) => (item.tone === "running" ? [] : [{ item, rank: ISSUE_RANK[item.tone] }]))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
  return {
    running,
    issues,
    count: present.length,
    summary: running.length > 0 ? running.map((item) => item.label).join(" · ") : null,
  };
}

export function importPreparationLabel(
  preparation: ImportPreparation,
  resolve: MessageResolver = m,
): string {
  if (preparation.kind === "file") {
    return resolve(msg("Reading references in {name}", { name: preparation.name }));
  }
  if (preparation.kind === "local-files" && preparation.names.length === 1) {
    return resolve(msg("Reading article metadata of {name}", { name: preparation.names[0]! }));
  }
  return resolve(msg("Reading article metadata"));
}

/** "Importing 6 of 200": the references settled so far, of all the import takes. */
export function importProgressLabel(
  operation: ScientSourceImportOperation,
  resolve: MessageResolver = m,
): string {
  const total = operation.items.length;
  const settled = operation.items.filter((item) => item.state !== "pending").length;
  return total > 0
    ? resolve(
        msg("Importing {settled} of {total}", {
          settled: settled.toLocaleString(),
          total: total.toLocaleString(),
        }),
      )
    : resolve(msg("Importing"));
}

export interface SourcesResultContent {
  readonly tone: "success" | "error" | "info";
  /** What happened, in at most two lines. */
  readonly summary: ReactNode;
  /** The whole receipt, shown in Activity. */
  readonly details?: ReactNode;
  /** The result's own actions, such as View or Add to this project. */
  readonly actions?: ReactNode;
}

export interface SourcesResult extends SourcesResultContent {
  readonly operationId: string;
}

/**
 * One result slot per project. The newest operation the person started owns it: starting one
 * clears what was shown, and only that operation's completion may fill it.
 */
export interface SourcesResultState {
  readonly context: string;
  readonly newest: string | null;
  readonly shown: SourcesResult | null;
}

export type SourcesResultAction =
  | { readonly type: "begin"; readonly context: string; readonly operationId: string }
  | {
      readonly type: "settle";
      readonly operationId: string;
      readonly content: SourcesResultContent | null;
    }
  | { readonly type: "dismiss" }
  | { readonly type: "contextChanged"; readonly context: string };

export function sourcesResultReducer(
  state: SourcesResultState,
  action: SourcesResultAction,
): SourcesResultState {
  switch (action.type) {
    case "begin":
      return { context: action.context, newest: action.operationId, shown: null };
    case "settle":
      if (action.operationId !== state.newest) return state;
      return {
        ...state,
        shown: action.content ? { ...action.content, operationId: action.operationId } : null,
      };
    case "dismiss":
      return { ...state, newest: null, shown: null };
    case "contextChanged":
      return action.context === state.context
        ? state
        : { context: action.context, newest: null, shown: null };
  }
}
