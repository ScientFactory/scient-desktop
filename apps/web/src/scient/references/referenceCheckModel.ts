import type {
  ScientReferenceCheckReport,
  ScientReferenceFinding,
} from "@scientfactory/scient-sources";

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

export function targetLabel(value: string): string {
  return value === "library" ? "Library" : value;
}

const GROUPS = [
  { severity: "problem", title: "Problems" },
  { severity: "warning", title: "Warnings" },
  { severity: "note", title: "Notes" },
] as const;

export function findingGroups(findings: ReadonlyArray<ScientReferenceFinding>) {
  return GROUPS.flatMap((group) => {
    const members = findings.filter((finding) => finding.severity === group.severity);
    return members.length > 0 ? [{ title: group.title, findings: members }] : [];
  });
}

/** One headline and the lines that say what the check could not cover. */
export function referenceCheckSummary(
  report: ScientReferenceCheckReport,
  active: ReadonlyArray<ScientReferenceFinding>,
): { readonly headline: string; readonly details: ReadonlyArray<string> } {
  const problems = active.filter((finding) => finding.severity === "problem").length;
  const warnings = active.filter((finding) => finding.severity === "warning").length;
  const notes = active.length - problems - warnings;
  const scope = count(report.references, "reference", "references");
  const found = [
    problems > 0 ? count(problems, "problem", "problems") : null,
    warnings > 0 ? count(warnings, "warning", "warnings") : null,
    notes > 0 ? count(notes, "note", "notes") : null,
  ].filter((part): part is string => part !== null);
  const headline =
    report.references === 0
      ? "No references found."
      : found.length === 0
        ? `No problems found in ${scope}.`
        : `${found.join(", ")} in ${scope}.`;
  return {
    headline,
    details: [
      ...(report.noIdentifier === 1
        ? ["1 reference has no DOI, PMID, arXiv ID or ISBN, so only its fields were checked."]
        : report.noIdentifier > 1
          ? [
              `${report.noIdentifier} references have no DOI, PMID, arXiv ID or ISBN, so only their fields were checked.`,
            ]
          : []),
      ...report.notes,
      ...(report.omittedFindings > 0
        ? [`${count(report.omittedFindings, "more finding is", "more findings are")} not shown.`]
        : []),
    ],
  };
}
