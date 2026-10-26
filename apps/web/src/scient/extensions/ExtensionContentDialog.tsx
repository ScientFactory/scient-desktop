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
  description,
  actions,
  footer,
  children,
  onOpenChange,
}: {
  readonly name: string;
  readonly kind: "Skill" | "Tool";
  readonly glyph: LucideIcon;
  readonly description: string;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup
        ref={popupRef}
        initialFocus={popupRef}
        layout="visual"
        className="max-w-3xl"
        showCloseButton={false}
        padding="none"
        gap="none"
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <ExtensionIcon name={name} glyph={glyph} size="large" />
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
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="mx-6 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
          <DialogPanel padding="none" scrollFade={false}>
            {children}
          </DialogPanel>
        </div>
        {footer}
      </DialogPopup>
    </Dialog>
  );
}
