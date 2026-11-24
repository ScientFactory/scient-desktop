import type {
  EnvironmentId,
  ScientSourceJournalIconResult,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import type { ScientSourceType } from "@scientfactory/scient-sources";
import {
  journalCoverDoiParts,
  journalCoverEligible,
  journalIconIdentity,
  journalRecordDoi,
} from "@t3tools/shared/scientJournalIdentity";
import { useMessages } from "gt-react";
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
import { publisherMark } from "./publisherMarks";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type JournalIcon = (NonNullable<ScientSourceJournalIconResult["icon"]> & { url: string }) | null;

/** What kind of source it is, when no publisher icon identifies it. */
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

type IconResolver = typeof readScientSourceJournalIcon;
type ResolvedJournalIcon = NonNullable<JournalIcon>;
type CachedIcon = {
  icon: JournalIcon;
  retryAt: number;
  pending?: Promise<void>;
};

const resolverCaches = new WeakMap<IconResolver, Map<string, CachedIcon>>();
const MAX_CACHED_JOURNALS = 256;
const RETRY_DELAY = 30_000;
const MISS_LIFETIME = 60_000;

function cachedIcon(resolveIcon: IconResolver, cacheKey: string): JournalIcon {
  const icon = resolverCaches.get(resolveIcon)?.get(cacheKey)?.icon;
  return icon && icon.expiresAt > Date.now() ? icon : null;
}

function discoverIcon(
  resolveIcon: IconResolver,
  cacheKey: string,
  lookupKey: string,
  environmentId: EnvironmentId,
  root: string,
  sourceId: string,
): CachedIcon {
  let cache = resolverCaches.get(resolveIcon);
  if (!cache) {
    cache = new Map();
    resolverCaches.set(resolveIcon, cache);
  }
  // Only successes are venue-wide; misses and pending lookups depend on the source's evidence.
  const shared = cache.get(cacheKey);
  if (shared && (shared.pending || shared.retryAt > Date.now())) return shared;
  const entry: CachedIcon = cache.get(lookupKey) ?? { icon: shared?.icon ?? null, retryAt: 0 };
  cache.delete(lookupKey);
  cache.set(lookupKey, entry);
  if (cache.size > MAX_CACHED_JOURNALS) cache.delete(cache.keys().next().value!);
  if (entry.pending || entry.retryAt > Date.now()) return entry;
  const renewal = Promise.resolve()
    .then(() => resolveIcon(environmentId, { root, sourceId }))
    .then((icon) => {
      const now = Date.now();
      if (icon && icon.expiresAt <= now + 1_000) {
        entry.retryAt = now + RETRY_DELAY;
        return;
      }
      entry.icon = icon ?? entry.icon;
      entry.retryAt = icon ? Math.max(now + 1_000, icon.expiresAt - 15_000) : now + MISS_LIFETIME;
      if (icon) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { icon, retryAt: entry.retryAt });
        if (cache.size > MAX_CACHED_JOURNALS) cache.delete(cache.keys().next().value!);
      }
    })
    .catch(() => {
      entry.retryAt = Date.now() + RETRY_DELAY;
    })
    .finally(() => {
      delete entry.pending;
      if (!shared) return;
      delete shared.pending;
      // Not renewed: the others wait as this card does, instead of each asking again.
      if (cache.get(cacheKey) === shared) shared.retryAt = Math.max(shared.retryAt, entry.retryAt);
    });
  entry.pending = renewal;
  // Cards that share a cover renew it once: the others wait on this lookup.
  if (shared) shared.pending = renewal;
  return entry;
}

/** The publisher's website icon, or what kind of source it is when no publisher is known. */
export function SourceJournalIcon(props: { readonly record: SourceRecord }) {
  const messages = useMessages();
  const mark = publisherMark(props.record);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const TypeIcon = SOURCE_TYPE_ICONS[props.record.type];
  const shown = mark && mark.url !== failedUrl ? mark : null;
  return (
    <ScientTooltip
      content={shown ? shown.name : messages(SCIENT_SOURCE_TYPE_LABELS[props.record.type])}
    >
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
        {shown ? (
          <img
            src={shown.url}
            alt=""
            draggable={false}
            className="size-full rounded-[3px] object-contain"
            onError={() => setFailedUrl(shown.url)}
          />
        ) : (
          <TypeIcon className="size-5" data-testid="source-generic-icon" />
        )}
      </span>
    </ScientTooltip>
  );
}

/** Papers of one journal share their DOI's cover evidence, so they share one cover. */
function coverEvidence(record: SourceRecord): string | null {
  const parts = journalCoverDoiParts(journalRecordDoi(record));
  return parts ? [parts.prefix, parts.springerJournal ?? parts.embeddedIssn ?? ""].join(" ") : null;
}

/** The journal's current cover, fetched by the environment; nothing while there is none. */
export function SourceJournalCover(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly record: SourceRecord;
  readonly resolveIcon?: IconResolver;
}) {
  const identity = journalIconIdentity(props.record);
  const cacheKey = JSON.stringify([
    props.environmentId,
    props.root,
    identity,
    coverEvidence(props.record),
  ]);
  const lookupKey = JSON.stringify([
    cacheKey,
    props.record.sourceId,
    props.record.identifiers.filter(({ scheme }) => /^(?:doi|e?issn)$/iu.test(scheme.trim())),
  ]);
  // A preprint or a source without a journal has no cover: nothing is asked or scheduled.
  if (!journalCoverEligible(props.record)) return null;
  return (
    <JournalCoverImage
      key={lookupKey}
      {...props}
      cacheKey={cacheKey}
      lookupKey={lookupKey}
      resolveIcon={props.resolveIcon ?? readScientSourceJournalIcon}
    />
  );
}

function JournalCoverImage(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly record: SourceRecord;
  readonly resolveIcon: IconResolver;
  readonly cacheKey: string;
  readonly lookupKey: string;
}) {
  const { environmentId, root, resolveIcon, cacheKey, lookupKey } = props;
  const sourceId = props.record.sourceId;
  const [discovered, setDiscovered] = useState<{
    resolver: IconResolver;
    icon: ResolvedJournalIcon;
  } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [shouldResolve, setShouldResolve] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const containerRef = useRef<HTMLSpanElement>(null);
  const resolved =
    discovered?.resolver === resolveIcon ? discovered.icon : cachedIcon(resolveIcon, cacheKey);
  const cover = resolved && resolved.url !== failedUrl ? resolved : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes viewport admission before starting environment discovery
  useEffect(() => {
    if (shouldResolve || typeof IntersectionObserver === "undefined") return;
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
  }, [shouldResolve]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns shared environment discovery and signed-asset renewal for an admitted card
  useEffect(() => {
    if (!shouldResolve) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      const entry = discoverIcon(resolveIcon, cacheKey, lookupKey, environmentId, root, sourceId);
      await entry.pending;
      if (!active) return;
      if (entry.icon && entry.icon.url !== failedUrl && entry.icon.expiresAt > Date.now()) {
        setDiscovered({ resolver: resolveIcon, icon: entry.icon });
      }
      timer = window.setTimeout(
        () => void refresh(),
        Math.min(2_147_483_647, Math.max(1_000, entry.retryAt - Date.now())),
      );
    };
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [shouldResolve, resolveIcon, cacheKey, lookupKey, environmentId, root, sourceId, failedUrl]);

  return (
    <span ref={containerRef} className="flex shrink-0 self-end" aria-hidden>
      {cover ? (
        <img
          src={cover.url}
          alt=""
          loading="lazy"
          draggable={false}
          data-testid="source-journal-cover"
          className="h-14 w-auto max-w-11 rounded-[2px] border border-border/70 object-cover shadow-[0_2px_6px_-2px_rgb(0_0_0/0.35)]"
          onError={() => {
            setFailedUrl(cover.url);
            const entry = resolverCaches.get(resolveIcon)?.get(cacheKey);
            if (entry) entry.retryAt = Date.now() + RETRY_DELAY;
          }}
        />
      ) : null}
    </span>
  );
}
