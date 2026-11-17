import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
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
import { useState } from "react";

import { bundledJournalMark, VENUE_TYPES } from "./bundledJournalIcons";
import { journalMarkLetters, journalMarkTone } from "./journalMark";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";

type SourceRecord = ScientSourcesOverviewResult["records"][number];

/** What kind of source it is, when it names no journal or venue. */
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

const VENUE_LABELS: Readonly<Record<string, string>> = {
  article: "Journal",
  "conference-paper": "Conference",
  preprint: "Preprint server",
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Letters drawn in a 20 px tile; three or four are fitted to its width, so none is clipped. */
function JournalMarkTile(props: { readonly letters: string; readonly title: string }) {
  const tone = journalMarkTone(props.title);
  const count = [...segmenter.segment(props.letters)].length;
  const fontSize = count <= 2 ? 10 : count === 3 ? 8 : 7;
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-full"
      style={{ letterSpacing: "normal", textTransform: "none" }}
      data-testid="source-journal-mark"
    >
      <rect
        width="20"
        height="20"
        rx="5"
        style={{ fill: `light-dark(${tone.light.background}, ${tone.dark.background})` }}
      />
      <text
        x="10"
        y="10"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight={600}
        {...(count >= 3 ? { textLength: 16, lengthAdjust: "spacingAndGlyphs" } : {})}
        style={{ fill: `light-dark(${tone.light.text}, ${tone.dark.text})` }}
      >
        {props.letters}
      </text>
    </svg>
  );
}

/**
 * The icon at the start of a row or card: a checked bundled mark for its exact match, else a
 * mark generated from the journal's name, else the source type's icon. Nothing is fetched.
 * `announce` gives screen readers the venue where the row shows no journal text of its own.
 */
export function SourceJournalIcon(props: {
  readonly record: SourceRecord;
  readonly announce?: boolean;
}) {
  const { record } = props;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const bundled = bundledJournalMark(record);
  const venueTitle = VENUE_TYPES.has(record.type)
    ? record.containerTitle?.trim() || record.containerTitleShort?.trim() || null
    : null;
  const letters =
    venueTitle === null
      ? null
      : journalMarkLetters(record.containerTitleShort?.trim() || venueTitle);
  const showBundled = bundled !== null && bundled.url !== failedUrl;
  const label = showBundled
    ? bundled.label
    : letters && venueTitle
      ? `${VENUE_LABELS[record.type]}: ${venueTitle}`
      : SCIENT_SOURCE_TYPE_LABELS[record.type];
  const TypeIcon = SOURCE_TYPE_ICONS[record.type];

  return (
    <ScientTooltip content={label}>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <span className="flex size-full items-center justify-center" aria-hidden>
          {showBundled ? (
            <img
              src={bundled.url}
              alt=""
              draggable={false}
              className="size-full object-contain"
              onError={() => setFailedUrl(bundled.url)}
            />
          ) : letters && venueTitle ? (
            <JournalMarkTile letters={letters} title={venueTitle} />
          ) : (
            <TypeIcon className="size-5" data-testid="source-generic-icon" />
          )}
        </span>
        {props.announce ? <span className="sr-only">{label}</span> : null}
      </span>
    </ScientTooltip>
  );
}
