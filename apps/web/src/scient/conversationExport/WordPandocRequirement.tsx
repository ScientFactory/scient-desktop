import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { formatMegabytes } from "../wordExport/pandocToolModel";
import { usePandocTool } from "../wordExport/usePandocTool";

/**
 * The Word dialog's content while Word export is unavailable: the one-line
 * Pandoc offer, the install progress, or why Word export cannot run here.
 */
export function WordPandocRequirement(props: {
  readonly environmentId: EnvironmentId;
  readonly reason: string;
  readonly disabled: boolean;
  readonly onAvailable: () => void;
}) {
  const { status, view, act, checking } = usePandocTool(props.environmentId, props.onAvailable);
  // Pandoc is installed, yet the server still cannot export Word: say why.
  if (view.kind === "ready") return <p className="text-muted-foreground text-sm">{props.reason}</p>;
  const offer = view.kind === "offer";
  const size = status?.downloadBytes == null ? "" : `${formatMegabytes(status.downloadBytes)}, `;
  const detail = offer ? `Word export needs Pandoc (${size}one-time download).` : view.detail;
  const actionLabel = offer ? "Install Pandoc" : view.actionLabel;
  return (
    <div className="flex flex-col items-start gap-3">
      <p
        className={view.kind === "failed" ? "text-destructive text-sm" : "text-sm"}
        role={view.kind === "failed" ? "alert" : view.busy ? "status" : undefined}
      >
        {detail}
      </p>
      {actionLabel !== null ? (
        <Button
          type="button"
          size="sm"
          variant={offer ? "default" : "outline"}
          disabled={view.busy || checking || props.disabled}
          onClick={act}
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
