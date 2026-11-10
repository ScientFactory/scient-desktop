import type { ScientSourceEditorialNotice, ScientSourceEditorialStatus } from "./model.ts";

type NoticeKind = ScientSourceEditorialNotice["kind"];

// Crossref and Retraction Watch write these with hyphens, underscores or spaces.
const NOTICE_KINDS: Readonly<Record<string, NoticeKind>> = {
  retraction: "retraction",
  "partial-retraction": "retraction",
  removal: "retraction",
  withdrawal: "withdrawal",
  "expression-of-concern": "expression-of-concern",
  correction: "correction",
  erratum: "correction",
  corrigendum: "correction",
};

const SEVERITY: ReadonlyArray<[NoticeKind, ScientSourceEditorialStatus["state"]]> = [
  ["retraction", "retracted"],
  ["withdrawal", "withdrawn"],
  ["expression-of-concern", "expression-of-concern"],
  ["correction", "corrected"],
];

/** The notice kind a registry update type names, or null for updates that change nothing. */
export function editorialNoticeKind(type: string): NoticeKind | null {
  return (
    NOTICE_KINDS[
      type
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/gu, "-")
    ] ?? null
  );
}

/** The most serious notice decides the state; the notices keep the detail, newest first. */
export function editorialStatusFromNotices(
  notices: ReadonlyArray<ScientSourceEditorialNotice>,
  checkedAt: string,
): ScientSourceEditorialStatus {
  const kinds = new Set(notices.map((notice) => notice.kind));
  const state = SEVERITY.find(([kind]) => kinds.has(kind))?.[1] ?? "none";
  const unique = [
    ...new Map(
      notices.map((notice) => [
        `${notice.kind}\0${notice.doi ?? ""}\0${notice.date ?? ""}`,
        notice,
      ]),
    ).values(),
  ];
  return {
    state,
    notices: unique
      .toSorted((left, right) => (right.date ?? "").localeCompare(left.date ?? ""))
      .slice(0, 64),
    checkedAt,
  };
}
