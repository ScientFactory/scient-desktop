import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { ScientSymbol } from "../../components/ScientSymbol";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  formatScientReleaseMonth,
  formatScientReleaseVersion,
  type ScientReleaseNote,
} from "./model";
import { useReleaseHistoryRequests } from "./releaseHistoryRequests";
import { useScientReleaseNotes, type ScientReleaseNotesController } from "./useScientReleaseNotes";

type ReleaseView = "release" | "history";

// One controller for the whole app: the sidebar card and the dialog must share their state.
const ScientReleaseNotesContext = createContext<ScientReleaseNotesController | null>(null);

/** Owns the release notes state. Mount it above both the sidebar and the app-wide dialog hosts. */
export function ScientReleaseNotesProvider({ children }: { readonly children: ReactNode }) {
  const controller = useScientReleaseNotes();
  const requestId = useReleaseHistoryRequests((state) => state.requestId);
  const [handledRequestId, setHandledRequestId] = useState(requestId);
  if (requestId !== handledRequestId) {
    setHandledRequestId(requestId);
    controller.openHistory();
  }
  return (
    <ScientReleaseNotesContext.Provider value={controller}>
      {children}
    </ScientReleaseNotesContext.Provider>
  );
}

function useScientReleaseNotesController(): ScientReleaseNotesController {
  const controller = useContext(ScientReleaseNotesContext);
  if (!controller) throw new Error("ScientReleaseNotesProvider is missing from the app root.");
  return controller;
}

/** The upgrade card, shown in the sidebar until the user dismisses it. */
export function ScientReleaseCard() {
  const controller = useScientReleaseNotesController();
  if (!controller.current || !controller.isCardVisible) return null;
  return (
    <ScientReleaseNotesCard
      release={controller.current}
      onDismiss={controller.dismissCard}
      onOpen={controller.openDialog}
    />
  );
}

/** The release notes dialog. Mounted at app level, so it stays open when the sidebar closes. */
export function ScientReleaseNotesDialogHost() {
  const controller = useScientReleaseNotesController();
  const opener = useReleaseHistoryRequests((state) => state.opener);
  if (!controller.current) return null;
  // Only a window opened from About gives focus back to the About button; the card's window keeps its default.
  return (
    <ScientReleaseNotesDialog
      current={controller.current}
      installedVersion={controller.installedVersion}
      history={controller.history}
      initialView={controller.dialogView}
      returnFocusTo={controller.dialogView === "history" ? opener : null}
      open={controller.isDialogOpen}
      onOpenChange={controller.setDialogOpen}
    />
  );
}

function ScientReleaseNotesCard({
  release,
  onDismiss,
  onOpen,
}: {
  readonly release: ScientReleaseNote;
  readonly onDismiss: () => void;
  readonly onOpen: () => void;
}) {
  const displayVersion = formatScientReleaseVersion(release.version);

  return (
    <section
      aria-label="New in Scient"
      className="group-data-[collapsible=icon]:hidden relative mb-1 w-full overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--scient-burgundy)_13%,var(--border))] bg-white shadow-[0_8px_26px_-22px_color-mix(in_srgb,var(--scient-burgundy)_55%,transparent)] dark:bg-[#151315]"
      data-scient-release-card
    >
      <ScientSymbol className="pointer-events-none absolute -bottom-7 -right-6 size-28 opacity-[0.055] dark:opacity-[0.09]" />
      <button
        aria-label={`Read what is new in Scient version ${displayVersion}`}
        className="group relative flex w-full flex-col items-start px-3 pb-3 pt-3.5 pe-8 text-left outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--scient-warm-white)_72%,transparent)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)]"
        onClick={onOpen}
        type="button"
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--scient-burgundy)] dark:text-[color-mix(in_srgb,var(--scient-warm-white)_82%,var(--scient-burgundy))]">
          New in Scient · v{displayVersion}
        </span>
        <span className="mt-1.5 max-w-[16rem] text-[13px] font-semibold leading-[1.35] text-foreground">
          {release.headline}
        </span>
        <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[color-mix(in_srgb,var(--scient-slate)_88%,var(--foreground))] transition-colors group-hover:text-[var(--scient-slate)] dark:text-[color-mix(in_srgb,var(--scient-warm-white)_68%,var(--scient-slate))]">
          See what&rsquo;s new
          <ArrowRightIcon aria-hidden className="size-3" />
        </span>
      </button>
      <button
        aria-label="Dismiss this release note"
        className="absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--scient-warm-white)_72%,transparent)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)]"
        onClick={onDismiss}
        type="button"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </section>
  );
}

function ScientReleaseNotesDialog({
  current,
  installedVersion,
  history,
  initialView,
  returnFocusTo,
  open,
  onOpenChange,
}: {
  readonly current: ScientReleaseNote;
  readonly installedVersion: string;
  readonly history: readonly ScientReleaseNote[];
  readonly initialView: ReleaseView;
  readonly returnFocusTo: HTMLElement | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<ReleaseView>(initialView);
  const [selected, setSelected] = useState(current);
  // "Back to this release" needs a release to go back to: the card's note, or one picked from the list.
  const [hasRelease, setHasRelease] = useState(initialView === "release");
  const titleRef = useRef<HTMLHeadingElement>(null);

  const [previousPresentation, setPreviousPresentation] = useState({
    current,
    open,
    initialView,
  });
  if (
    previousPresentation.current !== current ||
    previousPresentation.open !== open ||
    previousPresentation.initialView !== initialView
  ) {
    setPreviousPresentation({ current, open, initialView });
    if (open) {
      setSelected(current);
      setView(initialView);
      setHasRelease(initialView === "release");
    }
  }

  const focusRequest = { open, selected, view };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the dialog title via requestAnimationFrame when the view changes
  useEffect(() => {
    if (!focusRequest.open) return;
    // Re-focus when navigating between releases or the history view.
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        gap="none"
        padding="none"
        className="max-w-[34rem] overflow-hidden max-sm:max-h-[calc(100dvh-3rem)]"
        finalFocus={() =>
          returnFocusTo?.isConnected
            ? returnFocusTo
            : (document.querySelector<HTMLElement>(
                "[data-sidebar='footer'] [data-sidebar='menu-button']",
              ) ?? false)
        }
        initialFocus={titleRef}
      >
        <ScientReleaseDialogHeader
          release={selected}
          titleRef={titleRef}
          view={view}
          canReturnToRelease={hasRelease}
          onBack={() => setView("release")}
        />

        <DialogPanel
          padding={view === "release" ? "compact" : "none"}
          scrollAreaClassName={
            view === "release"
              ? "max-h-[min(32rem,calc(100dvh-12rem))]"
              : "max-h-[min(22rem,calc(100dvh-12rem))]"
          }
        >
          {view === "release" ? (
            <ScientReleaseDetail release={selected} />
          ) : (
            <ScientReleaseHistory
              currentVersion={installedVersion}
              releases={history}
              onSelect={(release) => {
                setSelected(release);
                setHasRelease(true);
                setView("release");
              }}
            />
          )}
        </DialogPanel>

        <DialogFooter className="sm:justify-between">
          {view === "release" ? (
            <Button size="sm" variant="ghost" onClick={() => setView("history")}>
              Release history
              <ArrowRightIcon />
            </Button>
          ) : (
            <span aria-hidden />
          )}
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ScientReleaseDialogHeader({
  release,
  titleRef,
  view,
  canReturnToRelease,
  onBack,
}: {
  readonly release: ScientReleaseNote;
  readonly titleRef: React.RefObject<HTMLHeadingElement | null>;
  readonly view: ReleaseView;
  readonly canReturnToRelease: boolean;
  readonly onBack: () => void;
}) {
  return (
    <div className="relative h-20" data-slot="dialog-header">
      <ScientSymbol className="pointer-events-none absolute -right-3 -top-4 size-32 opacity-[0.065] mask-[linear-gradient(to_bottom,#000_65%,transparent_100%)] dark:opacity-[0.09]" />
      {view === "release" ? (
        <div className="relative flex h-full w-full items-center gap-3 px-5 pr-14">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--scient-burgundy)_13%,var(--border))] bg-[var(--scient-warm-white)] dark:bg-white/5">
            <ScientSymbol className="size-[1.125rem]" />
          </div>
          <div className="min-w-0">
            <DialogTitle size="large" ref={titleRef} tabIndex={-1}>
              What&rsquo;s new in Scient
            </DialogTitle>
            <DialogDescription className="mt-0.5" size="compact">
              Version {formatScientReleaseVersion(release.version)} ·{" "}
              {formatScientReleaseMonth(release.publishedAt)}
            </DialogDescription>
          </div>
        </div>
      ) : (
        <div className="relative flex h-full w-full items-center gap-2 px-3 pr-14">
          {canReturnToRelease ? (
            <Button
              aria-label="Back to this release"
              size="icon-sm"
              variant="ghost"
              onClick={onBack}
            >
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <div>
            <DialogTitle size="large" ref={titleRef} tabIndex={-1}>
              Release history
            </DialogTitle>
            <DialogDescription className="mt-0.5" size="compact">
              Scient updates, newest first.
            </DialogDescription>
          </div>
        </div>
      )}
    </div>
  );
}

function ScientReleaseDetail({ release }: { readonly release: ScientReleaseNote }) {
  if (release.format === "paragraphs") {
    return (
      <div>
        <div className="-mx-5 -mt-5 px-5 pb-5 pt-7">
          <p className="text-lg font-semibold leading-snug text-foreground">{release.headline}</p>
        </div>

        <ScientReleaseParagraphs
          alsoIncluded={release.alsoIncluded}
          highlights={release.highlights}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="-mx-5 -mt-5 px-5 pb-5 pt-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--scient-burgundy)] dark:text-[color-mix(in_srgb,var(--scient-warm-white)_82%,var(--scient-burgundy))]">
          {release.kicker}
        </p>
        <p className="mt-1.5 text-base font-semibold leading-snug text-foreground">
          {release.headline}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{release.summary}</p>
      </div>

      <ScientReleaseParagraphs highlights={release.highlights} />
    </div>
  );
}

function releaseParagraphs(description: string) {
  const occurrences = new Map<string, number>();
  return description.split(/\n\n+/u).map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { text, key: JSON.stringify([text, occurrence]) };
  });
}

function ScientReleaseParagraphs({
  highlights,
  alsoIncluded,
}: {
  readonly highlights: ScientReleaseNote["highlights"];
  readonly alsoIncluded?: string;
}) {
  return (
    <div>
      <ol className="mt-1 grid list-decimal gap-4 pl-[1.625rem] marker:text-sm marker:font-medium marker:text-[var(--scient-slate)] dark:marker:text-[var(--scient-warm-white)]">
        {highlights.map((highlight) => (
          <li className="min-w-0 pl-0.5" key={highlight.id}>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-5 text-foreground">{highlight.title}</p>
              {releaseParagraphs(highlight.description).map(({ text, key }) => (
                <p key={key} className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {text}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ol>
      {alsoIncluded ? (
        <div className="mt-4 min-w-0">
          <p className="text-sm font-semibold leading-5 text-foreground">Also included</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{alsoIncluded}</p>
        </div>
      ) : null}
    </div>
  );
}

function ScientReleaseHistory({
  currentVersion,
  releases,
  onSelect,
}: {
  readonly currentVersion: string;
  readonly releases: readonly ScientReleaseNote[];
  readonly onSelect: (release: ScientReleaseNote) => void;
}) {
  return (
    <div className="divide-y divide-border/70" role="list">
      {releases.map((release) => {
        const isCurrent = release.version === currentVersion;
        return (
          <div key={release.version} role="listitem">
            <button
              aria-label={`Read release notes for Scient ${formatScientReleaseVersion(release.version)}${isCurrent ? ", current version" : ""}`}
              className={
                isCurrent
                  ? "block w-full cursor-pointer bg-[linear-gradient(90deg,color-mix(in_srgb,var(--scient-warm-white)_74%,white)_0%,transparent_100%)] px-5 py-4 text-left outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--scient-warm-white)_55%,white)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)] dark:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--scient-burgundy)_12%,transparent)_0%,transparent_100%)]"
                  : "block w-full cursor-pointer px-5 py-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)]"
              }
              onClick={() => onSelect(release)}
              type="button"
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-semibold leading-5 text-foreground">
                  Scient {formatScientReleaseVersion(release.version)}
                </span>
                {isCurrent ? (
                  <span className="rounded-full bg-[color-mix(in_srgb,var(--scient-slate)_10%,transparent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--scient-slate)] dark:bg-white/[0.06] dark:text-[var(--scient-warm-white)]">
                    Current
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                {formatScientReleaseMonth(release.publishedAt)}
              </span>
              <span className="mt-1.5 block text-[13px] leading-5 text-muted-foreground">
                {release.headline}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
