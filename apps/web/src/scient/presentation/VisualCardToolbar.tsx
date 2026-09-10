import { MoveIcon, RotateCcwIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { MenuItem, MenuPopup, MenuSeparator } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { attachVisualCardToolbarDrag } from "./visualCardToolbarDrag";

const ToolbarPositionContext = createContext<{
  readonly moving: boolean;
  readonly handle: RefObject<HTMLButtonElement | null>;
  readonly beginMove: () => void;
  readonly reset: () => void;
} | null>(null);

/** Menu closing owns the focus transfer to the temporary movement handle. */
export function VisualCardMenuPopup(props: ComponentProps<typeof MenuPopup>) {
  const position = useContext(ToolbarPositionContext);
  return (
    <MenuPopup
      {...props}
      finalFocus={
        props.finalFocus ?? (position?.moving ? () => position.handle.current : undefined)
      }
    />
  );
}

export function VisualCardToolbarMenuItems() {
  const position = useContext(ToolbarPositionContext);
  if (!position) return null;
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={position.beginMove}>
        <MoveIcon />
        Move controls
      </MenuItem>
      <MenuItem onClick={position.reset}>
        <RotateCcwIcon />
        Reset controls position
      </MenuItem>
    </>
  );
}

/** Toolbar-local presentation/position; renderers retain actions, state, and sizing. */
export function VisualCardToolbar(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
  readonly variant?: "utilities" | "exploration";
}) {
  const toolbarRef = useRef<HTMLSpanElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState(false);
  const exploration = props.variant === "exploration";
  const movementAllowed = useRef(false);
  useLayoutEffect(() => {
    movementAllowed.current = exploration || moving;
  }, [exploration, moving]);
  const controller = useRef<ReturnType<typeof attachVisualCardToolbarDrag> | null>(null);
  const position = useMemo(
    () =>
      exploration
        ? null
        : {
            moving,
            handle: handleRef,
            beginMove: () => setMoving(true),
            reset: () => {
              controller.current?.reset();
              setMoving(false);
            },
          },
    [exploration, moving],
  );

  useEffect(() => {
    const toolbar = toolbarRef.current;
    const handle = handleRef.current;
    if (!toolbar || !handle) return;
    const attached = attachVisualCardToolbarDrag(
      toolbar,
      handle,
      setDragging,
      () => movementAllowed.current,
    );
    controller.current = attached;
    return () => {
      controller.current = null;
      attached();
    };
  }, []);

  return (
    <ToolbarPositionContext.Provider value={position}>
      <span
        ref={toolbarRef}
        aria-label={props.label}
        className={cn(
          "relative z-10 inline-flex max-w-full flex-wrap items-center justify-end gap-0.5 focus-within:z-20 [&_button:disabled]:pointer-events-auto [&_button:disabled]:cursor-default",
          exploration
            ? "touch-none cursor-grab rounded-md border border-border/40 bg-background/70 py-0.5 pr-0.5 pl-2.5"
            : "scient-visual-utility-controls",
          moving && "pl-5",
          dragging && "cursor-grabbing",
          props.className,
        )}
        role="group"
        onBlur={(event) => {
          if (
            moving &&
            event.currentTarget.contains(event.target) &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            setMoving(false);
        }}
        onKeyDown={(event) => {
          if (!moving || (event.key !== "Escape" && event.key !== "Enter")) return;
          event.preventDefault();
          event.stopPropagation();
          setMoving(false);
          toolbarRef.current?.querySelector<HTMLButtonElement>("[aria-haspopup='menu']")?.focus();
        }}
      >
        <Tooltip disabled={dragging}>
          <TooltipTrigger
            render={
              <button
                ref={handleRef}
                data-scient-toolbar-move
                hidden={!exploration && !moving}
                aria-label={`Move ${props.label.toLowerCase()}`}
                className={cn(
                  "absolute top-1/2 left-0 z-10 flex h-5 w-2.5 -translate-y-1/2 touch-none cursor-grab select-none items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground active:cursor-grabbing [&[hidden]]:hidden",
                  dragging && "cursor-grabbing",
                )}
                type="button"
              />
            }
          >
            <span aria-hidden="true" className="pointer-events-none flex flex-col gap-0.5">
              <span className="size-0.5 rounded-full bg-current" />
              <span className="size-0.5 rounded-full bg-current" />
              <span className="size-0.5 rounded-full bg-current" />
              <span className="size-0.5 rounded-full bg-current" />
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            Drag or use arrow keys to move. Shift moves precisely; Home resets.
            {!exploration && " Press Enter or Escape to finish."}
          </TooltipPopup>
        </Tooltip>
        {props.children}
      </span>
    </ToolbarPositionContext.Provider>
  );
}

export function VisualCardDetails(props: {
  readonly title: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="max-w-72 border-b border-border/60 px-2 py-1.5 text-xs" dir="auto">
      <div className="wrap-anywhere font-medium">{props.title}</div>
      {props.detail ? (
        <div className="mt-0.5 wrap-anywhere text-muted-foreground">{props.detail}</div>
      ) : null}
    </div>
  );
}
