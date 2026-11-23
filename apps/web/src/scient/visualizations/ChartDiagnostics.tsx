import { T, useGT } from "gt-react";
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { MenuItem, MenuSeparator } from "~/components/ui/menu";

import { VisualCardMenuPopup } from "../presentation/VisualCardToolbar";

interface ChartActionsMenuProps {
  readonly children: ReactNode;
  readonly warnings: ReadonlyArray<string>;
}

export function ChartActionsMenuPopup(props: ChartActionsMenuProps) {
  return (
    <VisualCardMenuPopup align="end" className="w-72" width="content">
      <ChartActionsMenuContent {...props} />
    </VisualCardMenuPopup>
  );
}

function ChartActionsMenuContent({ children, warnings }: ChartActionsMenuProps) {
  const gt = useGT();
  const [showWarnings, setShowWarnings] = useState(false);
  const warningListId = useId();
  const restoreFocus = useRef(false);
  const hasWarnings = warnings.length > 0;
  if (showWarnings && !hasWarnings) setShowWarnings(false);

  const focusNavigationItem = (item: HTMLDivElement | null) => {
    if (!item || !restoreFocus.current) return;
    restoreFocus.current = false;
    item.focus();
  };

  const navigate = (show: boolean) => {
    restoreFocus.current = true;
    setShowWarnings(show);
  };

  if (showWarnings && hasWarnings) {
    return (
      <>
        <MenuItem
          aria-describedby={warningListId}
          closeOnClick={false}
          onClick={() => navigate(false)}
          ref={focusNavigationItem}
        >
          <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
          <T>Back</T>
        </MenuItem>
        <MenuSeparator />
        <div className="px-2 pt-1 pb-2 text-xs" dir="auto">
          <div className="font-medium">
            <T>Chart warnings</T>
          </div>
          <ul className="mt-1 list-disc space-y-1 ps-4 text-muted-foreground" id={warningListId}>
            {warnings.map((warning) => (
              <li className="wrap-anywhere" key={warning}>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  return (
    <>
      {children}
      {hasWarnings ? (
        <>
          <MenuSeparator />
          <MenuItem closeOnClick={false} onClick={() => navigate(true)} ref={focusNavigationItem}>
            <TriangleAlertIcon aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {gt("Chart warnings ({count})", { count: warnings.length })}
            </span>
            <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

export function ChartRenderError({
  label,
  message,
  onRetry,
}: {
  readonly label: ReactNode;
  readonly message: string;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-2 text-xs">
      <div className="min-w-0 flex-1" dir="auto" role="status">
        <p className="font-medium">{label}</p>
        <p className="wrap-anywhere text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button onClick={onRetry} size="xs" type="button" variant="ghost">
          <RefreshCwIcon />
          <T>Retry</T>
        </Button>
      ) : null}
    </div>
  );
}
