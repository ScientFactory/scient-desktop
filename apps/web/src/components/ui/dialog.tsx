"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { ScrollArea } from "~/components/ui/scroll-area";

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  variant = "default",
  ...props
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media" }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "media" ? DIALOG_MEDIA_BACKDROP_CLASS : DIALOG_BACKDROP_CLASS,
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 [-webkit-app-region:no-drag]",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  showBackdrop = true,
  bottomStickOnMobile = true,
  variant = "default",
  layout = "default",
  padding = "default",
  gap = "default",
  backdropClassName,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  showBackdrop?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media";
  /** Shared layout for large, media-like content viewers. */
  layout?: "default" | "visual";
  padding?: "default" | "none";
  gap?: "default" | "none";
  /** Allows feature-owned dialogs to tune the shared backdrop without replacing it. */
  backdropClassName?: string;
}) {
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      {showBackdrop ? (
        <DialogBackdrop
          className={cn(variant === "media" && "z-[60]", backdropClassName)}
          variant={variant}
        />
      ) : null}
      <DialogViewport
        className={cn(
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          variant === "media" &&
            "z-[60] grid-rows-1 place-items-center px-4 py-6 [-webkit-app-region:no-drag]",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            variant === "media" ? DIALOG_MEDIA_POPUP_CLASS : DIALOG_POPUP_CLASS,
            "row-start-2 text-popover-foreground",
            variant === "default" && "max-h-full max-w-lg",
            layout === "visual" &&
              "flex h-[min(84vh,56rem)] w-[min(88vw,88rem)] max-w-none flex-col overflow-hidden max-sm:h-[92vh] max-sm:w-[94vw]",
            padding === "none" && "p-0",
            gap === "none" && "gap-0",
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
          data-layout={layout}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  layout = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  layout?: "default" | "visual";
  size?: "default" | "compact";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        layout === "visual" && "flex-row items-center gap-3 border-b px-4 py-3 pe-12",
        size === "compact" && "gap-2 p-4",
        className,
      )}
      data-slot="dialog-header"
      data-layout={layout}
      data-size={size}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = "default",
  padding = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
  padding?: "default" | "compact";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        padding === "compact" && "px-4 pb-4 pt-0",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({
  className,
  size = "default",
  ...props
}: DialogPrimitive.Title.Props & { size?: "default" | "compact" | "large" }) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "wrap-anywhere font-heading font-semibold leading-none",
        size === "compact" ? "text-base" : size === "large" ? "text-lg leading-5" : "text-xl",
        className,
      )}
      data-slot="dialog-title"
      data-size={size}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  size = "default",
  ...props
}: DialogPrimitive.Description.Props & { size?: "default" | "compact" }) {
  return (
    <DialogPrimitive.Description
      className={cn(
        "text-muted-foreground",
        size === "compact" ? "text-xs leading-4" : "text-sm",
        className,
      )}
      data-slot="dialog-description"
      data-size={size}
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollAreaClassName,
  scrollFade = true,
  padding = "default",
  spacing = "default",
  ...props
}: React.ComponentProps<"div"> & {
  scrollAreaClassName?: string;
  scrollFade?: boolean;
  padding?: "default" | "compact" | "none";
  spacing?: "default" | "compact";
}) {
  return (
    <ScrollArea className={scrollAreaClassName} scrollFade={scrollFade}>
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          spacing === "compact" && "space-y-3",
          padding === "compact" && "px-5 pb-4 pt-5",
          padding === "none" && "p-0",
          className,
        )}
        data-slot="dialog-panel"
        data-padding={padding}
        data-spacing={spacing}
        {...props}
      />
    </ScrollArea>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
