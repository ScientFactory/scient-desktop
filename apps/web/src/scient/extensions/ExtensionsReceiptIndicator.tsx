import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PlugIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { useEnvironmentQuery } from "../../state/query";
import { extensionsDeliveryReceipt } from "./extensionsState";
import { SKIP_REASON_LABELS } from "./extensionsView";

/**
 * What the thread's current provider session received from Connected services.
 * Hidden until a session has been issued with a receipt.
 */
export function ExtensionsReceiptIndicator({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const receipt = useEnvironmentQuery(
    extensionsDeliveryReceipt({ environmentId, input: { threadId } }),
  ).data?.receipt;
  if (!receipt || (receipt.delivered.length === 0 && receipt.skipped.length === 0)) return null;
  const delivered = receipt.delivered.length;
  const skipped = receipt.skipped.length;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Connected services: ${delivered} delivered, ${skipped} skipped`}
        data-extensions-receipt=""
        render={<Button variant="outline" size="micro" className="shrink-0" />}
      >
        <PlugIcon aria-hidden className="size-3" />
        <span>{delivered}</span>
        {skipped > 0 ? <span className="text-warning-foreground">· {skipped} skipped</span> : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="comfortable">
        <div className="grid gap-3 text-xs">
          <PopoverTitle>Connected services</PopoverTitle>
          <section className="grid gap-1" aria-label="Delivered">
            <h3 className="text-muted-foreground">Delivered to this session</h3>
            {delivered === 0 ? (
              <p className="text-muted-foreground">None</p>
            ) : (
              <ul className="grid gap-1">
                {receipt.delivered.map((entry) => (
                  <li key={entry.connectorId} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-foreground">{entry.displayName}</span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {entry.serverName}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {skipped > 0 ? (
            <section className="grid gap-1" aria-label="Skipped">
              <h3 className="text-muted-foreground">Skipped</h3>
              <ul className="grid gap-1">
                {receipt.skipped.map(({ entry, reason }) => (
                  <li
                    key={entry.connectorId}
                    data-skip-reason={reason}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="truncate text-foreground">{entry.displayName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {SKIP_REASON_LABELS[reason]}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            className="-ms-2 justify-self-start"
            render={
              <Link to="/settings/extensions/installed" search={{ machine: environmentId }} />
            }
          >
            Manage connected services
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
