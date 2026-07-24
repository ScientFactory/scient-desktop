// FILE: whatsNew/WhatsNewPopoutCard.tsx
// Purpose: Render the once-per-release Scient card inside the sidebar footer.

import { useEffect, useRef } from "react";

import { ScientLogo } from "~/components/ScientLogo";
import { DialogTrigger } from "~/components/ui/dialog";
import { ArrowRightIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import type { WhatsNewEntry } from "./logic";
import type { WhatsNewDialogHandle } from "./WhatsNewProvider";

export interface WhatsNewPopoutCardProps {
  readonly entry: WhatsNewEntry;
  readonly currentVersion: string;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
  readonly onPresented: () => void;
  readonly dialogHandle: WhatsNewDialogHandle;
  readonly className?: string;
}

export function WhatsNewPopoutCard({
  entry,
  currentVersion,
  onOpen,
  onDismiss,
  onPresented,
  dialogHandle,
  className,
}: WhatsNewPopoutCardProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const didPresentRef = useRef(false);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const markWhenVisible = (visible: boolean) => {
      const isPerceivable =
        shell.isConnected &&
        !shell.closest("[inert]") &&
        (typeof shell.checkVisibility !== "function" ||
          shell.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      if (
        !visible ||
        !isPerceivable ||
        didPresentRef.current ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      )
        return;
      didPresentRef.current = true;
      onPresented();
    };

    const checkGeometry = () => {
      const rect = shell.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const area = rect.width * rect.height;
      markWhenVisible(area > 0 && (visibleWidth * visibleHeight) / area >= 0.95);
    };

    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            ([entry]) => markWhenVisible((entry?.intersectionRatio ?? 0) >= 0.95),
            { threshold: 0.95 },
          )
        : null;
    observer?.observe(shell);

    const frame = requestAnimationFrame(checkGeometry);
    document.addEventListener("visibilitychange", checkGeometry);
    window.addEventListener("focus", checkGeometry);
    window.addEventListener("resize", checkGeometry);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", checkGeometry);
      window.removeEventListener("focus", checkGeometry);
      window.removeEventListener("resize", checkGeometry);
    };
  }, [onPresented]);

  const heroAlt = entry.heroImageAlt ?? `Highlights from Scient v${currentVersion}`;

  return (
    <div
      ref={shellRef}
      data-testid="whats-new-sidebar-card"
      className={cn(
        "relative w-full min-w-0 overflow-hidden rounded-xl border border-primary/20",
        "bg-[linear-gradient(145deg,color-mix(in_srgb,var(--color-primary)_12%,var(--sidebar))_0%,var(--sidebar)_72%)]",
        "shadow-[0_10px_28px_-18px_color-mix(in_srgb,var(--color-primary)_70%,transparent)]",
        className,
      )}
    >
      <DialogTrigger
        handle={dialogHandle}
        render={
          <button
            type="button"
            data-whats-new-trigger
            aria-label={`Read what improved in Scient v${currentVersion}`}
            onClick={onOpen}
            className={cn(
              "group flex w-full min-w-0 flex-col overflow-hidden text-start",
              "outline-hidden transition-[border-color,background-color]",
              "hover:bg-primary/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            )}
          />
        }
      >
        <div className="relative flex h-16 w-full items-center justify-center overflow-hidden">
          {entry.heroImage ? (
            <img
              src={entry.heroImage}
              alt={heroAlt}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center bg-[radial-gradient(100%_140%_at_8%_0%,color-mix(in_srgb,var(--color-primary)_35%,transparent)_0%,transparent_62%),radial-gradient(85%_120%_at_100%_100%,color-mix(in_srgb,var(--color-primary)_22%,transparent)_0%,transparent_72%)]"
            >
              <ScientLogo className="size-8" />
            </div>
          )}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-b from-transparent to-sidebar/80"
          />
        </div>

        <span className="flex min-w-0 w-full flex-col gap-1 px-3 pb-3 pt-2.5 pe-9">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-primary uppercase">
            New in Scient · v{currentVersion}
          </span>
          <span className="line-clamp-2 text-xs font-semibold leading-snug text-sidebar-foreground">
            {entry.headline}
          </span>
          <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground group-hover:text-sidebar-foreground">
            See what improved
            <ArrowRightIcon aria-hidden className="size-3" />
          </span>
        </span>
      </DialogTrigger>

      <button
        type="button"
        aria-label={`Dismiss Scient v${currentVersion} release note`}
        onClick={onDismiss}
        className={cn(
          "absolute end-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-full",
          "bg-sidebar/65 text-muted-foreground backdrop-blur-sm transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        )}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
