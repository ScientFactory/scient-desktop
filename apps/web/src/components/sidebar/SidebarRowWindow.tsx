import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useSidebarRowVisibility } from "./sidebarRowVisibility";

/** Keeps list geometry and sortable targets while limiting expensive controls to nearby rows. */
export function SidebarRowWindow({
  children,
  placeholder,
  alwaysRender,
  sortableRef,
  ...props
}: Omit<ComponentProps<"li">, "children" | "ref"> & {
  children: (retain: (open: boolean) => void) => ReactNode;
  placeholder: ReactNode;
  alwaysRender: boolean;
  sortableRef?: ((node: HTMLElement | null) => void) | undefined;
}) {
  const { rowRef, isNearViewport } = useSidebarRowVisibility();
  const element = useRef<HTMLLIElement | null>(null);
  const restoreFocus = useRef(false);
  const [hasFocus, setHasFocus] = useState(false);
  const [hasPointer, setHasPointer] = useState(false);
  const [hasNativeDrag, setHasNativeDrag] = useState(false);
  const [hasOpenControl, setHasOpenControl] = useState(false);
  const renderBody =
    alwaysRender || isNearViewport || hasFocus || hasPointer || hasNativeDrag || hasOpenControl;
  const ref = useCallback(
    (node: HTMLLIElement | null) => {
      element.current = node;
      rowRef(node);
      sortableRef?.(node);
    },
    [rowRef, sortableRef],
  );

  useLayoutEffect(() => {
    if (!renderBody || !restoreFocus.current) return;
    restoreFocus.current = false;
    element.current
      ?.querySelector<HTMLElement>("[data-sidebar-row-trigger]")
      ?.focus({ preventScroll: true });
  }, [renderBody]);

  useEffect(() => {
    if (!hasNativeDrag) return;
    const clearDrag = () => setHasNativeDrag(false);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("dragend", clearDrag);
    return () => {
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("dragend", clearDrag);
    };
  }, [hasNativeDrag]);

  return (
    <li
      {...props}
      ref={ref}
      data-sidebar-row-body={renderBody ? "mounted" : "placeholder"}
      onFocusCapture={(event) => {
        props.onFocusCapture?.(event);
        if (!event.currentTarget.contains(event.target)) return;
        if (!renderBody) restoreFocus.current = true;
        setHasFocus(true);
      }}
      onBlurCapture={(event) => {
        props.onBlurCapture?.(event);
        if (!event.currentTarget.contains(event.relatedTarget)) setHasFocus(false);
      }}
      onPointerEnter={(event) => {
        props.onPointerEnter?.(event);
        if (event.target instanceof Node && event.currentTarget.contains(event.target))
          setHasPointer(true);
      }}
      onPointerLeave={(event) => {
        props.onPointerLeave?.(event);
        setHasPointer(false);
      }}
      onDragEnterCapture={(event) => {
        props.onDragEnterCapture?.(event);
        if (event.target instanceof Node && event.currentTarget.contains(event.target))
          setHasNativeDrag(true);
      }}
      onDragLeaveCapture={(event) => {
        props.onDragLeaveCapture?.(event);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setHasNativeDrag(false);
      }}
      onDropCapture={(event) => {
        props.onDropCapture?.(event);
        setHasNativeDrag(false);
      }}
      onDragEndCapture={(event) => {
        props.onDragEndCapture?.(event);
        setHasNativeDrag(false);
      }}
    >
      {renderBody ? children(setHasOpenControl) : placeholder}
    </li>
  );
}
