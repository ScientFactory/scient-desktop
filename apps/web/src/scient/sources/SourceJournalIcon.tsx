import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { BookOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readScientSourceJournalIcon } from "./client";
import { ScientTooltip } from "../presentation/ScientTooltip";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type JournalIcon = Awaited<ReturnType<typeof readScientSourceJournalIcon>>;

function canResolveJournalIcon(record: SourceRecord): boolean {
  return (
    record.type === "article" &&
    Boolean(record.containerTitle?.trim()) &&
    (Boolean(record.url?.trim()) ||
      record.identifiers.some((identifier) => identifier.scheme.trim().toLowerCase() === "doi"))
  );
}

export function SourceJournalIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly record: SourceRecord;
  readonly resolveIcon?: typeof readScientSourceJournalIcon;
}) {
  const [icon, setIcon] = useState<JournalIcon>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [shouldResolve, setShouldResolve] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const containerRef = useRef<HTMLSpanElement>(null);
  const resolveIcon = props.resolveIcon ?? readScientSourceJournalIcon;
  const eligible = canResolveJournalIcon(props.record);

  const [previousVisibility, setPreviousVisibility] = useState({
    eligible: eligible,
    sourceId: props.record.sourceId,
  });
  if (
    previousVisibility.eligible !== eligible ||
    previousVisibility.sourceId !== props.record.sourceId
  ) {
    setPreviousVisibility({ eligible: eligible, sourceId: props.record.sourceId });
    setShouldResolve(typeof IntersectionObserver === "undefined");
  }
  useEffect(() => {
    if (!previousVisibility.eligible || typeof IntersectionObserver === "undefined") return;
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldResolve(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [previousVisibility]);

  const [previousIconInput, setPreviousIconInput] = useState({
    eligible: eligible,
    environmentId: props.environmentId,
    revision: props.record.revision,
    sourceId: props.record.sourceId,
    root: props.root,
    resolveIcon: resolveIcon,
    shouldResolve: shouldResolve,
  });
  if (
    previousIconInput.eligible !== eligible ||
    previousIconInput.environmentId !== props.environmentId ||
    previousIconInput.revision !== props.record.revision ||
    previousIconInput.sourceId !== props.record.sourceId ||
    previousIconInput.root !== props.root ||
    previousIconInput.resolveIcon !== resolveIcon ||
    previousIconInput.shouldResolve !== shouldResolve
  ) {
    setPreviousIconInput({
      eligible: eligible,
      environmentId: props.environmentId,
      revision: props.record.revision,
      sourceId: props.record.sourceId,
      root: props.root,
      resolveIcon: resolveIcon,
      shouldResolve: shouldResolve,
    });
    setIcon(null);
    setImageFailed(false);
  }
  useEffect(() => {
    let active = true;
    const { eligible, shouldResolve, resolveIcon, environmentId, root, sourceId } =
      previousIconInput;
    if (!eligible || !shouldResolve) return () => undefined;
    void resolveIcon(environmentId, {
      root,
      sourceId,
    })
      .then((result) => {
        if (active) setIcon(result);
      })
      .catch(() => {
        if (active) setIcon(null);
      });
    return () => {
      active = false;
    };
  }, [previousIconInput]);

  const journalIcon = (
    <span
      ref={containerRef}
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
      aria-hidden
    >
      {icon && !imageFailed ? (
        <img
          src={icon.url}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full rounded-[3px] object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <BookOpen className="size-4" data-testid="source-generic-icon" />
      )}
    </span>
  );

  return icon && !imageFailed ? (
    <ScientTooltip content={icon.journalTitle}>{journalIcon}</ScientTooltip>
  ) : (
    journalIcon
  );
}

export const sourceJournalIconInternals = { canResolveJournalIcon };
