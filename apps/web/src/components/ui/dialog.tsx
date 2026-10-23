import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useContext } from "react";
import { OverlayScrollScope } from "./overlay-scroll-scope";
import { XIcon } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, use, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_PAPER_BACKDROP_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { ScrollArea } from "~/components/ui/scroll-area";

const ControlledOpenContext = createContext<boolean | undefined>(undefined);

function RetainedWhileClosed({ open, children }: { open: boolean; children: ReactNode }) {
  const controlledOpen = use(ControlledOpenContext);
  const isOpen = open && controlledOpen !== false;
  const [retained, setRetained] = useState(children);
  if (isOpen && retained !== children) {
    setRetained(children);
  }
  return isOpen ? children : retained;
}

function renderRetainedPopup(props: ComponentProps<"div">, state: { open: boolean }) {
  return (
    <div {...props}>
      <RetainedWhileClosed open={state.open}>{props.children}</RetainedWhileClosed>
    </div>
  );
}

function Dialog<Payload>(props: DialogPrimitive.Root.Props<Payload>) {
  return (
    <ControlledOpenContext value={props.open}>
      <DialogPrimitive.Root {...props} />
    </ControlledOpenContext>
  );
}

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
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media" | "paper" }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "paper"
          ? DIALOG_PAPER_BACKDROP_CLASS
          : variant === "media"
            ? DIALOG_MEDIA_BACKDROP_CLASS
            : DIALOG_BACKDROP_CLASS,
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
  layer = "default",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  showBackdrop?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media" | "paper";
  /** Shared layout for large, media-like content viewers. */
  layout?: "default" | "visual";
  padding?: "default" | "none";
  gap?: "default" | "none";
  /** Allows feature-owned dialogs to tune the shared backdrop without replacing it. */
  backdropClassName?: string;
  /** A viewer opened from a menu or preview card must sit above its opener. */
  layer?: "default" | "above-popovers";
}) {
  const isViewer = variant !== "default";
  const scrollScope = useContext(OverlayScrollScope);
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      {showBackdrop ? (
        <DialogBackdrop
          className={cn(
            isViewer && "z-[60]",
            layer === "above-popovers" && "z-[150]",
            backdropClassName,
          )}
          variant={variant}
        />
      ) : null}
      <DialogViewport
        className={cn(
          !showBackdrop && "pointer-events-none",
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          isViewer &&
            "z-[60] grid-rows-1 place-items-center px-4 pb-6 pt-[calc(var(--native-titlebar-height,0px)+1.5rem)] [-webkit-app-region:no-drag]",
          layer === "above-popovers" && "z-[150]",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            !showBackdrop && "pointer-events-auto",
            isViewer ? DIALOG_MEDIA_POPUP_CLASS : DIALOG_POPUP_CLASS,
            "row-start-2 text-popover-foreground",
            variant === "default" && "max-h-full max-w-lg",
            layout === "visual" &&
              "flex h-[min(84vh,56rem)] w-[min(88vw,88rem)] max-w-none flex-col overflow-hidden max-sm:h-[92vh] max-sm:w-[94vw]",
            padding === "none" && "p-0",
            gap === "none" && "gap-0",
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          {...scrollScope?.portalProps}
          data-overlay-scroll-scope={scrollScope?.id}
          data-slot="dialog-popup"
          data-layout={layout}
          render={renderRetainedPopup}
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
}: DialogPrimitive.Title.Props & { size?: "default" | "compact" | "large" | "caption" }) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "wrap-anywhere font-heading leading-none",
        size === "caption"
          ? "text-xs font-normal text-muted-foreground"
          : cn(
              "font-semibold",
              size === "compact" ? "text-base" : size === "large" ? "text-lg leading-5" : "text-xl",
            ),
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
  ControlledOpenContext,
  renderRetainedPopup,
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
