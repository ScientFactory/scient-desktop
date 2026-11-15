import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import type { ScientSourceType } from "@scientfactory/scient-sources";
import {
  Book,
  BookOpenText,
  ClipboardList,
  CodeXml,
  Database,
  File,
  FileClock,
  FileText,
  Globe,
  GraduationCap,
  type LucideIcon,
  Presentation,
  Projector,
  ScrollText,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readScientSourceJournalIcon } from "./client";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type JournalIcon = Awaited<ReturnType<typeof readScientSourceJournalIcon>>;

/** What kind of source it is, at a glance, until its journal's own icon arrives. */
const SOURCE_TYPE_ICONS = {
  article: FileText,
  preprint: FileClock,
  book: Book,
  "book-chapter": BookOpenText,
  "conference-paper": Presentation,
  thesis: GraduationCap,
  report: ClipboardList,
  dataset: Database,
  web: Globe,
  software: CodeXml,
  presentation: Projector,
  manuscript: ScrollText,
  other: File,
} as const satisfies Readonly<Record<ScientSourceType, LucideIcon>>;

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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers icon resolution until the container DOM node nears the viewport via IntersectionObserver
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the journal icon from the environment when inputs change, ignoring stale completions
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

  const TypeIcon = SOURCE_TYPE_ICONS[props.record.type];
  const journalIcon = (
    <span
      ref={containerRef}
      className="flex size-4 shrink-0 items-center justify-center"
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
        <TypeIcon className="size-4" data-testid="source-generic-icon" />
      )}
    </span>
  );

  return (
    <ScientTooltip
      content={
        icon && !imageFailed ? icon.journalTitle : SCIENT_SOURCE_TYPE_LABELS[props.record.type]
      }
    >
      {journalIcon}
    </ScientTooltip>
  );
}

export const sourceJournalIconInternals = { canResolveJournalIcon };
