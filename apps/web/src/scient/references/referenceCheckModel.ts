import type {
  ScientReferenceCheckReport,
  ScientReferenceFinding,
} from "@scientfactory/scient-sources";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export function targetLabel(value: string, resolve: MessageResolver = m): string {
  return value === "library"
    ? resolve(msg("Library", { $context: "the personal Library of sources" }))
    : value;
}

const GROUPS = [
  { severity: "problem", title: msg("Problems", { $context: "reference check findings" }) },
  { severity: "warning", title: msg("Warnings", { $context: "reference check findings" }) },
  { severity: "note", title: msg("Notes", { $context: "reference check findings" }) },
] as const;

export function findingGroups(
  findings: ReadonlyArray<ScientReferenceFinding>,
  resolve: MessageResolver = m,
) {
  return GROUPS.flatMap((group) => {
    const members = findings.filter((finding) => finding.severity === group.severity);
    return members.length > 0 ? [{ title: resolve(group.title), findings: members }] : [];
  });
}

/** One headline and the lines that say what the check could not cover. */
export function referenceCheckSummary(
  report: ScientReferenceCheckReport,
  active: ReadonlyArray<ScientReferenceFinding>,
  resolve: MessageResolver = m,
): { readonly headline: string; readonly details: ReadonlyArray<string> } {
  const problems = active.filter((finding) => finding.severity === "problem").length;
  const warnings = active.filter((finding) => finding.severity === "warning").length;
  const notes = active.length - problems - warnings;
  const references = report.references;
  const found = [
    problems > 0
      ? resolve(
          msg("{count, plural, one {{count} problem} other {{count} problems}}", {
            count: problems,
          }),
        )
      : null,
    warnings > 0
      ? resolve(
          msg("{count, plural, one {{count} warning} other {{count} warnings}}", {
            count: warnings,
          }),
        )
      : null,
    notes > 0
      ? resolve(msg("{count, plural, one {{count} note} other {{count} notes}}", { count: notes }))
      : null,
  ].filter((part): part is string => part !== null);
  const headline =
    report.references === 0
      ? resolve(msg("No references found."))
      : found.length === 0
        ? resolve(
            msg(
              "{count, plural, one {No problems found in {count} reference.} other {No problems found in {count} references.}}",
              { count: references },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {{found} in {count} reference.} other {{found} in {count} references.}}",
              { found: found.join(", "), count: references },
            ),
          );
  return {
    headline,
    details: [
      ...(report.noIdentifier === 1
        ? [
            resolve(
              msg(
                "1 reference has no DOI, PMID, arXiv ID or ISBN, so only its fields were checked.",
              ),
            ),
          ]
        : report.noIdentifier > 1
          ? [
              resolve(
                msg(
                  "{count} references have no DOI, PMID, arXiv ID or ISBN, so only their fields were checked.",
                  { count: report.noIdentifier },
                ),
              ),
            ]
          : []),
      ...report.notes,
      ...(report.omittedFindings > 0
        ? [
            resolve(
              msg(
                "{count, plural, one {{count} more finding is not shown.} other {{count} more findings are not shown.}}",
                { count: report.omittedFindings },
              ),
            ),
          ]
        : []),
    ],
  };
}
