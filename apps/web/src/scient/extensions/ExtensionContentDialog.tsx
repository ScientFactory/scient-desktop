import { type LucideIcon, XIcon } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { ExtensionIcon } from "./ExtensionRow";

export function ExtensionContentDialog({
  name,
  kind,
  glyph,
  iconUrl,
  description,
  actions,
  footer,
  children,
  framed = true,
  onOpenChange,
}: {
  readonly name: string;
  readonly kind: "Skill" | "Tool" | "App";
  readonly glyph?: LucideIcon | undefined;
  readonly iconUrl?: string | undefined;
  readonly description: string;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  /** Draws the scrolling content inside a bordered box (documents); off for lists. */
  readonly framed?: boolean | undefined;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup
        ref={popupRef}
        initialFocus={popupRef}
        className="flex max-h-[min(70vh,680px)] w-full max-w-xl flex-col overflow-hidden"
        showCloseButton={false}
        padding="none"
        gap="none"
      >
        <DialogHeader size="compact">
          <div className="flex items-start justify-between gap-4">
            <ExtensionIcon
              name={name}
              glyph={iconUrl ? undefined : glyph}
              iconUrl={iconUrl}
              size="row"
            />
            <div className="flex items-center gap-1">
              {actions}
              <DialogClose
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Close ${kind.toLowerCase()}`}
                  />
                }
              >
                <XIcon aria-hidden />
              </DialogClose>
            </div>
          </div>
          <DialogTitle>
            {name} <span className="font-normal text-muted-foreground">{kind}</span>
          </DialogTitle>
          <DialogDescription className={kind === "App" ? "whitespace-pre-line" : undefined}>
            {kind === "App" ? description : <span className="line-clamp-3">{description}</span>}
          </DialogDescription>
        </DialogHeader>
        {framed ? (
          <div className="mx-4 mb-4 flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background">
            <DialogPanel padding="none" scrollFade={false}>
              {children}
            </DialogPanel>
          </div>
        ) : (
          <DialogPanel padding="none" scrollFade={false}>
            {children}
          </DialogPanel>
        )}
        {footer}
      </DialogPopup>
    </Dialog>
  );
}
