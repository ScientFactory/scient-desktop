import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { BookOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readScientSourceJournalIcon } from "./client";

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

  useEffect(() => {
    setShouldResolve(typeof IntersectionObserver === "undefined");
    if (!eligible || typeof IntersectionObserver === "undefined") return;
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
  }, [eligible, props.record.sourceId]);

  useEffect(() => {
    let active = true;
    setIcon(null);
    setImageFailed(false);
    if (!eligible || !shouldResolve) return () => undefined;
    void resolveIcon(props.environmentId, {
      root: props.root,
      sourceId: props.record.sourceId,
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
  }, [
    eligible,
    props.environmentId,
    props.record.revision,
    props.record.sourceId,
    props.root,
    resolveIcon,
    shouldResolve,
  ]);

  return (
    <span
      ref={containerRef}
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
      title={icon && !imageFailed ? icon.journalTitle : undefined}
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
}

export const sourceJournalIconInternals = { canResolveJournalIcon };
