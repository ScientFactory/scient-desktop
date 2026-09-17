import { ChevronDownIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { SETTINGS_SOURCE_RISE, settingsSourceOutline } from "./settingsSourceOutline";

/** Owns only the decorative connection between a disclosure strip and its panel. */
export function SettingsSourceGroup({
  activePanelId,
  children,
}: {
  readonly activePanelId: string | null;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState<{
    id: string;
    path: string;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !activePanelId) return;
    const strip = host.querySelector<HTMLElement>(".settings-source-strip");
    const trigger = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button[aria-controls]"),
    ).find((button) => button.getAttribute("aria-controls") === activePanelId);
    const panel = Array.from(host.querySelectorAll<HTMLElement>("[data-source-panel]")).find(
      (element) => element.id === activePanelId,
    );
    if (!strip || !trigger || !panel) return;
    const measure = () => {
      const origin = host.getBoundingClientRect();
      const body = panel.getBoundingClientRect();
      const label = trigger.getBoundingClientRect();
      const viewport = strip.getBoundingClientRect();
      const center = (label.left + label.right) / 2;
      const path = settingsSourceOutline(
        body.width,
        body.height,
        Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius),
        center < viewport.left || center > viewport.right ? null : center - body.left,
      );
      const next = path
        ? {
            id: activePanelId,
            path,
            left: body.left - origin.left,
            top: body.top - origin.top - SETTINGS_SOURCE_RISE,
            width: body.width,
            height: body.height + SETTINGS_SOURCE_RISE,
          }
        : null;
      setOutline((previous) =>
        previous?.id === next?.id &&
        previous?.path === next?.path &&
        previous?.left === next?.left &&
        previous?.top === next?.top
          ? previous
          : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    // Earlier labels can change width without resizing the strip itself.
    for (const element of [host, strip, panel, ...strip.querySelectorAll("button[aria-controls]")])
      observer?.observe(element);
    strip.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer?.disconnect();
      strip.removeEventListener("scroll", measure);
    };
  }, [activePanelId]);
  const visible = outline?.id === activePanelId ? outline : null;
  return (
    <div
      ref={ref}
      className="settings-source-group"
      data-source-outline={visible ? "ready" : undefined}
    >
      {visible ? (
        <svg
          aria-hidden="true"
          focusable="false"
          className="settings-source-outline"
          style={{
            left: visible.left,
            top: visible.top,
            width: visible.width,
            height: visible.height,
          }}
        >
          <path d={visible.path} vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      {children}
    </div>
  );
}

/** Shared disclosure-panel surface used by Skills and runtime settings. */
export function SettingsSourcePanel(props: Omit<ComponentProps<"div">, "className">) {
  return (
    <div
      {...props}
      data-source-panel=""
      className="rounded-xl border border-border/60 bg-card/40 py-1 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50"
    />
  );
}

export function SettingsSourceStrip(props: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      aria-label={props.label}
      className="settings-source-strip flex items-center overflow-x-auto py-1"
      role="group"
    >
      {props.children}
    </div>
  );
}

export function SettingsSourceStripItem(props: {
  readonly id?: string;
  readonly controls: string;
  readonly detail?: ReactNode;
  readonly expanded: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly separated: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      {props.separated ? <span aria-hidden className="mx-2 h-7 w-px bg-border/65" /> : null}
      <button
        id={props.id}
        type="button"
        aria-controls={props.controls}
        aria-expanded={props.expanded}
        className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-expanded:bg-foreground/[0.035]"
        onClick={props.onToggle}
      >
        {props.icon}
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="max-w-52 truncate text-sm font-medium text-foreground">
              {props.label}
            </span>
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180"
            />
          </span>
          {props.detail ? (
            <span className="block text-xs text-muted-foreground">{props.detail}</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
