import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ScientSymbol } from "../../components/ScientSymbol";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  formatScientReleaseMonth,
  formatScientReleaseVersion,
  type ScientReleaseNote,
} from "./model";
import { useScientReleaseNotes } from "./useScientReleaseNotes";

type ReleaseView = "release" | "history";

export function ScientReleaseNotes() {
  const controller = useScientReleaseNotes();
  if (!controller.current) return null;

  return (
    <>
      {controller.isCardVisible ? (
        <ScientReleaseNotesCard
          release={controller.current}
          onDismiss={controller.dismissCard}
          onOpen={controller.openDialog}
        />
      ) : null}
      <ScientReleaseNotesDialog
        current={controller.current}
        history={controller.history}
        open={controller.isDialogOpen}
        onOpenChange={controller.setDialogOpen}
      />
    </>
  );
}

export function ScientReleaseNotesCard({
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
        className="absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--scient-warm-white)_72%,transparent)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)]"
        onClick={onDismiss}
        type="button"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </section>
  );
}

export function ScientReleaseNotesDialog({
  current,
  history,
  open,
  onOpenChange,
}: {
  readonly current: ScientReleaseNote;
  readonly history: readonly ScientReleaseNote[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<ReleaseView>("release");
  const [selected, setSelected] = useState(current);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(current);
    setView("release");
  }, [current, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, selected, view]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-[34rem] gap-0 overflow-hidden p-0 max-sm:max-h-[calc(100dvh-3rem)]"
        finalFocus={() =>
          document.querySelector<HTMLElement>(
            "[data-sidebar='footer'] [data-sidebar='menu-button']",
          ) ?? false
        }
        initialFocus={titleRef}
      >
        <ScientReleaseDialogHeader
          release={selected}
          titleRef={titleRef}
          view={view}
          onBack={() => setView("release")}
        />

        <DialogPanel className={view === "release" ? "px-5 pb-4 pt-5" : "max-h-[22rem] p-0"}>
          {view === "release" ? (
            <ScientReleaseDetail release={selected} />
          ) : (
            <ScientReleaseHistory
              currentVersion={current.version}
              releases={history}
              onSelect={(release) => {
                setSelected(release);
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
          <Button
            className="bg-[linear-gradient(135deg,color-mix(in_srgb,var(--scient-slate)_78%,white)_0%,var(--scient-slate)_58%,color-mix(in_srgb,var(--scient-slate)_90%,black)_100%)] text-white hover:brightness-[0.96]"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
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
  onBack,
}: {
  readonly release: ScientReleaseNote;
  readonly titleRef: React.RefObject<HTMLHeadingElement | null>;
  readonly view: ReleaseView;
  readonly onBack: () => void;
}) {
  return (
    <DialogHeader className="relative h-20 overflow-hidden bg-[linear-gradient(105deg,color-mix(in_srgb,var(--scient-warm-white)_88%,white)_0%,color-mix(in_srgb,var(--scient-warm-white)_42%,white)_58%,white_100%)] !p-0 dark:bg-[#151315]">
      <ScientSymbol className="pointer-events-none absolute -right-3 -top-4 size-32 opacity-[0.065] dark:opacity-[0.09]" />
      {view === "release" ? (
        <div className="relative flex h-full w-full items-center gap-3 px-5 pr-14">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--scient-burgundy)_13%,var(--border))] bg-[var(--scient-warm-white)] dark:bg-white/5">
            <ScientSymbol className="size-[1.125rem]" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-lg leading-5" ref={titleRef} tabIndex={-1}>
              What&rsquo;s new in Scient
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs leading-4">
              Version {formatScientReleaseVersion(release.version)} ·{" "}
              {formatScientReleaseMonth(release.publishedAt)}
            </DialogDescription>
          </div>
        </div>
      ) : (
        <div className="relative flex h-full w-full items-center gap-2 px-3 pr-14">
          <Button aria-label="Back to this release" size="icon-sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
          <div>
            <DialogTitle className="text-lg leading-5" ref={titleRef} tabIndex={-1}>
              Release history
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs leading-4">
              Scient updates, newest first.
            </DialogDescription>
          </div>
        </div>
      )}
    </DialogHeader>
  );
}

function ScientReleaseDetail({ release }: { readonly release: ScientReleaseNote }) {
  return (
    <div>
      <div className="-mx-5 -mt-5 bg-[linear-gradient(180deg,transparent_0%,white_100%),linear-gradient(105deg,color-mix(in_srgb,var(--scient-warm-white)_88%,white)_0%,color-mix(in_srgb,var(--scient-warm-white)_42%,white)_58%,white_100%)] px-5 pb-5 pt-7 dark:bg-[linear-gradient(180deg,transparent_0%,#151315_100%),linear-gradient(105deg,color-mix(in_srgb,var(--scient-burgundy)_15%,#151315)_0%,#151315_100%)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--scient-burgundy)] dark:text-[color-mix(in_srgb,var(--scient-warm-white)_82%,var(--scient-burgundy))]">
          {release.kicker}
        </p>
        <p className="mt-1.5 text-base font-semibold leading-snug text-foreground">
          {release.headline}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{release.summary}</p>
      </div>

      <div className="mt-1 grid gap-4">
        {release.highlights.map((highlight, index) => (
          <div className="flex gap-3" key={highlight.id}>
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--scient-slate)_10%,transparent)] text-[11px] font-semibold text-[var(--scient-slate)] dark:bg-white/[0.06] dark:text-[var(--scient-warm-white)]">
              {index + 1}
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">{highlight.title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {highlight.description}
              </p>
            </div>
          </div>
        ))}
      </div>
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
              aria-label={`Read release notes for Scient ${formatScientReleaseVersion(release.version)}`}
              className={
                isCurrent
                  ? "block w-full bg-[linear-gradient(90deg,color-mix(in_srgb,var(--scient-warm-white)_74%,white)_0%,transparent_100%)] px-5 py-4 text-left outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--scient-warm-white)_55%,white)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)] dark:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--scient-burgundy)_12%,transparent)_0%,transparent_100%)]"
                  : "block w-full px-5 py-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--scient-slate)_62%,transparent)]"
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
