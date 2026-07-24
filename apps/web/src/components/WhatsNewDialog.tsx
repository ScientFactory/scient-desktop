// FILE: WhatsNewDialog.tsx
// Purpose: Render the one-time "What's new" release-notes dialog shown after
// an update. Two views: a default "What's new?" card stack anchored on the
// installed release, and a secondary "Release history" accordion spanning
// every curated release. Open/close state and the underlying data are owned
// by `useWhatsNew`; this component is pure presentation.
// Layer: Chat shell overlay (mounted once from the root route).

import { useEffect, useRef, useState } from "react";

import { ArrowLeftIcon, ArrowRightIcon } from "~/lib/icons";
import { ScientLogo } from "~/components/ScientLogo";

import { ChangelogAccordion } from "../whatsNew/ChangelogAccordion";
import { FeatureSection } from "../whatsNew/FeatureSection";
import type { WhatsNewEntry } from "../whatsNew/logic";
import type { WhatsNewDialogHandle } from "../whatsNew/WhatsNewProvider";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

type View = "current" | "changelog";

export interface WhatsNewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The entry matching the installed build. `null` means "nothing to show" —
   * the hook only flips `open=true` when we have an entry, so normally this is
   * non-null while the dialog is visible. We still guard against the null
   * case to keep the UI tolerant of mid-transition re-renders.
   */
  readonly currentEntry: WhatsNewEntry | null;
  /** Full curated history, newest-first, for the changelog accordion. */
  readonly allEntries: readonly WhatsNewEntry[];
  readonly currentVersion: string;
  readonly dialogHandle: WhatsNewDialogHandle;
}

export default function WhatsNewDialog({
  open,
  onOpenChange,
  currentEntry,
  allEntries,
  currentVersion,
  dialogHandle,
}: WhatsNewDialogProps) {
  const [view, setView] = useState<View>("current");
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Reset back to the primary view whenever the dialog re-opens so the next
  // release doesn't boot into the secondary "Release history" screen just
  // because the user left it there on a previous open.
  useEffect(() => {
    if (open) {
      setView("current");
    }
  }, [open]);

  // Guard against a race where the hook has already reset but base-ui is
  // still transitioning — rendering an empty card would briefly flash a
  // confusing empty state.
  if (!currentEntry) {
    return (
      <Dialog handle={dialogHandle} open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-md" />
      </Dialog>
    );
  }

  return (
    <Dialog handle={dialogHandle} open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-lg gap-0 p-0"
        initialFocus={titleRef}
        finalFocus={() =>
          document.querySelector<HTMLElement>("[data-activity-center-trigger]") ?? false
        }
      >
        <DialogHeader className="gap-1 p-4 pr-12">
          {view === "current" ? (
            <CurrentHeader
              entry={currentEntry}
              currentVersion={currentVersion}
              titleRef={titleRef}
            />
          ) : (
            <ChangelogHeader onBack={() => setView("current")} />
          )}
        </DialogHeader>

        <DialogPanel className="max-h-[min(62vh,520px)] px-4 py-3">
          {view === "current" ? (
            <div className="flex flex-col gap-8 py-1">
              {currentEntry.features.map((feature) => (
                <FeatureSection key={feature.id} feature={feature} />
              ))}
            </div>
          ) : (
            <ChangelogAccordion
              entries={allEntries}
              defaultExpandedVersion={currentEntry.version}
            />
          )}
        </DialogPanel>

        <DialogFooter className="sm:justify-between">
          {view === "current" ? (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground"
              onClick={() => setView("changelog")}
            >
              Release history
              <ArrowRightIcon className="size-3" />
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

function CurrentHeader({
  entry,
  currentVersion,
  titleRef,
}: {
  readonly entry: WhatsNewEntry;
  readonly currentVersion: string;
  readonly titleRef: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="flex items-center gap-3">
      <ScientLogo aria-hidden className="size-8 shrink-0" />
      <div className="flex min-w-0 flex-col">
        <DialogTitle ref={titleRef} tabIndex={-1} className="text-base outline-none">
          What&rsquo;s new in Scient
        </DialogTitle>
        <DialogDescription className="text-xs">
          v{currentVersion}
          <span aria-hidden="true"> · </span>
          {entry.date}
        </DialogDescription>
      </div>
    </div>
  );
}

function ChangelogHeader({ onBack }: { readonly onBack: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <Button size="icon-sm" variant="ghost" aria-label="Back to What's new" onClick={onBack}>
        <ArrowLeftIcon className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-col">
        <DialogTitle className="text-base">Release history</DialogTitle>
        <DialogDescription className="text-xs">
          Earlier Scient updates, newest first.
        </DialogDescription>
      </div>
    </div>
  );
}
