import { useState } from "react";
import { shallow } from "zustand/vanilla/shallow";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
} from "../session-logic";

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    shallow(left.visibleTurnItems, right.visibleTurnItems) &&
    shallow(left.optimisticMessages, right.optimisticMessages) &&
    sameAnchoredMessages(left.anchoredMessages, right.anchoredMessages) &&
    shallow(left.attachmentUrlById, right.attachmentUrlById) &&
    shallow(left.attempts, right.attempts) &&
    shallow(left.nodes, right.nodes) &&
    shallow(left.plans, right.plans)
  );
}

function sameAnchoredMessages(
  left: TimelineEntriesInput["anchoredMessages"],
  right: TimelineEntriesInput["anchoredMessages"],
): boolean {
  if (shallow(left, right)) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  // Local feedback messages are reconstructed from immutable submissions. Compare
  // their fields, not allocation identity; nested attachments still use identity.
  return left.every((message, index) => shallow(message, right[index]));
}

export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  const [state, setState] = useState(() => ({
    threadKey,
    projection: deriveTimelineEntriesFromVisibleTurnItemsWithState(input),
  }));
  if (state.threadKey === threadKey && sameInput(state.projection.input, input)) {
    return state.projection.entries;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    state.threadKey === threadKey ? state.projection : null,
  );
  setState({ threadKey, projection });
  return projection.entries;
}
