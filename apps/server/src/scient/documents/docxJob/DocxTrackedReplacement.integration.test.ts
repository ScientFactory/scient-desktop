// @effect-diagnostics nodeBuiltinImport:off -- Qualification hashes inputs and writes review evidence.
/**
 * Real-engine qualification. Runs only with SCIENT_DOCUMENT_LAB_SOFFICE naming the pinned
 * LibreOffice; never downloads. SCIENT_DOCUMENT_LAB_EVIDENCE_OUT keeps the PDFs, the edited
 * copy and evidence.json for visual review. The workflow counts passed cases, so a skip fails it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  DATED_ID,
  HEBREW_WORD,
  REVIEW,
  SIGNED_RANGE,
  fixtureBytes,
  hiddenIdFixture,
} from "./docxJob.testkit.ts";
import { runDocxTrackedReplacement, type DocxJobResult } from "./DocxTrackedReplacementJob.ts";
import { OfficeRenderer, makeOfficeRenderer, probeOfficeVersion } from "./OfficeRenderer.ts";
import { OFFICE_TOOLCHAIN, isPinnedOfficeVersion } from "./officeToolchainManifest.ts";
import { readPdfLayout, type PdfLayout } from "./pdfLayout.ts";

const soffice = process.env.SCIENT_DOCUMENT_LAB_SOFFICE?.trim() || null;
const evidenceDirectory = process.env.SCIENT_DOCUMENT_LAB_EVIDENCE_OUT?.trim() || null;
const stagingRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-docx-job-"));
const platform = HostProcess.Platform.defaultValue();
const hostEnvironment = HostProcess.Environment.defaultValue();
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const withRenderer = <A, E>(effect: Effect.Effect<A, E, OfficeRenderer>) =>
  Effect.gen(function* () {
    const renderer = yield* makeOfficeRenderer({
      soffice: soffice!,
      stagingRoot,
      platform,
      hostEnvironment,
      // Below the suite's ceiling, so a stuck engine fails as a typed timeout.
      timeout: "100 seconds",
    });
    return yield* effect.pipe(Effect.provideService(OfficeRenderer, renderer));
  }).pipe(Effect.provide(NodeServices.layer));

/** Items of one page whose text is exactly `needle`'s pieces, left to right as drawn. */
const visualOrder = (layout: PdfLayout, page: number, pieces: ReadonlyArray<string>) =>
  layout.pages[page - 1]!.filter((item) => pieces.includes(item.str))
    .toSorted((a, b) => a.x - b.x)
    .map((item) => item.str);

const pagesWith = (layout: PdfLayout, text: string) =>
  layout.pages.flatMap((items, index) =>
    items.some((item) => item.str.includes(text)) ? [index + 1] : [],
  );

const evidence: Record<string, unknown> = {
  platform: `${platform}-${HostProcess.Architecture.defaultValue()}`,
  pinned: `${OFFICE_TOOLCHAIN.engine} ${OFFICE_TOOLCHAIN.version} ${OFFICE_TOOLCHAIN.buildId}`,
  scenarios: {},
};
const record = (name: string, result: DocxJobResult, extra: Record<string, unknown>) => {
  (evidence.scenarios as Record<string, unknown>)[name] = {
    checks: result.checks,
    pageCount: result.pageCount,
    editPage: result.editPage,
    producer: result.producer,
    fonts: result.fonts,
    inventory: result.inventory,
    candidateDocxSha256: sha256(result.candidateDocx),
    warnings: result.warnings,
    ...extra,
  };
  if (evidenceDirectory === null) return;
  NodeFS.mkdirSync(evidenceDirectory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(evidenceDirectory, `${name}-source.pdf`), result.sourcePdf);
  NodeFS.writeFileSync(
    NodePath.join(evidenceDirectory, `${name}-candidate.pdf`),
    result.candidatePdf,
  );
  NodeFS.writeFileSync(
    NodePath.join(evidenceDirectory, `${name}-candidate.docx`),
    result.candidateDocx,
  );
  NodeFS.writeFileSync(
    NodePath.join(evidenceDirectory, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
};

describe.skipIf(soffice === null)("tracked replacement with the pinned LibreOffice", () => {
  it.effect("runs the exact pinned build", () =>
    Effect.gen(function* () {
      const printed = yield* probeOfficeVersion({
        soffice: soffice!,
        stagingRoot,
        platform,
        hostEnvironment,
      }).pipe(Effect.provide(NodeServices.layer));
      evidence.engine = printed.trim();
      expect(isPinnedOfficeVersion(printed)).toBe(true);
    }),
  );

  it.effect(
    "replaces the dated ID in mixed Hebrew text and keeps the range, table pages and source",
    () =>
      withRenderer(
        Effect.gen(function* () {
          const source = fixtureBytes();
          const before = sha256(source);
          const result = yield* runDocxTrackedReplacement(source, { ...DATED_ID, ...REVIEW });
          expect(result.checks.filter((check) => !check.passed)).toEqual([]);
          expect(result.checks).toHaveLength(14);
          expect(result.warnings).toEqual(["bidi-neutral-at-edge"]);
          expect(sha256(source)).toBe(before);
          expect(result.producer).toContain(`LibreOffice ${OFFICE_TOOLCHAIN.version}`);
          expect(result.inventory).toMatchObject({
            commentAnchors: 3,
            equations: 1,
            rightToLeftTables: 1,
            repeatedHeaderRows: 1,
            insertions: 2,
            deletions: 1,
          });

          const sourceLayout = yield* readPdfLayout(result.sourcePdf);
          const candidateLayout = yield* readPdfLayout(result.candidatePdf);
          const range = ["−", "3.2", "–", "4.5"];
          const sourceRange = visualOrder(sourceLayout, result.editPage, range);
          expect(sourceRange).toHaveLength(4);
          // Preservation, not correction: the inherited drawing order of the range is unchanged.
          expect(visualOrder(candidateLayout, result.editPage, range)).toEqual(sourceRange);
          const tableHeading = "אתר";
          expect(pagesWith(candidateLayout, tableHeading)).toEqual(
            pagesWith(sourceLayout, tableHeading),
          );
          expect(pagesWith(candidateLayout, tableHeading).length).toBeGreaterThan(1);
          record("dated-id", result, {
            sourceSha256: before,
            signedRange: SIGNED_RANGE,
            signedRangeDrawnLeftToRight: sourceRange,
            tableHeadingPages: pagesWith(candidateLayout, tableHeading),
          });
        }),
      ),
  );

  it.effect("replaces a Hebrew word in a right-to-left paragraph", () =>
    withRenderer(
      Effect.gen(function* () {
        const result = yield* runDocxTrackedReplacement(fixtureBytes(), {
          ...HEBREW_WORD,
          ...REVIEW,
        });
        expect(result.checks.filter((check) => !check.passed)).toEqual([]);
        record("hebrew-word", result, {});
      }),
    ),
  );

  it.effect("returns nothing when the render cannot show the edit", () =>
    withRenderer(
      Effect.gen(function* () {
        const hidden = yield* hiddenIdFixture;
        const exit = yield* runDocxTrackedReplacement(hidden, { ...DATED_ID, ...REVIEW }).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
        const error = failure?._tag === "Fail" ? failure.error : undefined;
        expect(error).toMatchObject({ code: "integrity-failed", reason: "pdf-checks" });
        const failed = (error?.checks ?? [])
          .filter((check) => !check.passed)
          .map((check) => check.id);
        expect(failed).toContain("pdf-source-text-located");
        (evidence.scenarios as Record<string, unknown>)["hidden-id"] = {
          refused: error?.reason,
          failed,
        };
        if (evidenceDirectory !== null)
          NodeFS.writeFileSync(
            NodePath.join(evidenceDirectory, "evidence.json"),
            `${JSON.stringify(evidence, null, 2)}\n`,
          );
      }),
    ),
  );
});
