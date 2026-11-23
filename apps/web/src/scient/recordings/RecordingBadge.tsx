import { useGT } from "gt-react";
import { Badge } from "../../components/ui/badge";
import type { RecordingStatus } from "../../rpc/transcription";

export function RecordingBadge({
  state,
  reviewCount,
}: {
  state: RecordingStatus["state"];
  reviewCount?: number | undefined;
}) {
  const gt = useGT();
  if (state.stage === "completed" && reviewCount) {
    return (
      <Badge variant="warning" size="sm">
        {gt("Needs review · {count}", { count: reviewCount })}
      </Badge>
    );
  }
  switch (state.stage) {
    case "completed":
      // Done is the normal state; only states that need attention get a badge.
      return null;
    case "interrupted":
    case "paused":
      return (
        <Badge variant="secondary" size="sm">
          {gt("Paused")}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="error" size="sm">
          {gt("Couldn’t finish")}
        </Badge>
      );
    case "canceled":
      return (
        <Badge variant="secondary" size="sm">
          {gt("Canceled")}
        </Badge>
      );
    default:
      return (
        <Badge variant="info" size="sm">
          {state.total
            ? gt("Transcribing · {percent}%", {
                percent: Math.min(100, Math.round((100 * state.completed) / state.total)),
              })
            : gt("Transcribing")}
        </Badge>
      );
  }
}
