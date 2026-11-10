import type {
  ScientReferenceCheckReport,
  ScientReferenceFinding,
} from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ReferenceCheckDialog } from "./ReferenceCheckDialog";

const mocks = vi.hoisted(() => ({
  checkReferences: vi.fn(),
  readReferenceDocuments: vi.fn(),
  resolveReferences: vi.fn(),
}));

vi.mock("./client", () => mocks);

const environmentId = "environment-1" as EnvironmentId;

const finding = (fields: Partial<ScientReferenceFinding>): ScientReferenceFinding => ({
  findingId: "finding",
  kind: "details-differ",
  severity: "warning",
  key: null,
  label: null,
  location: null,
  sourceId: null,
  message: "Message.",
  registry: null,
  related: null,
  fix: null,
  ignored: false,
  ...fields,
});

const yearFix = {
  kind: "bibtex-field",
  path: "refs.bib",
  key: "smith2020",
  field: "year",
  current: "2020",
  value: "2021",
} as const;

const report = (findings: ReadonlyArray<ScientReferenceFinding>): ScientReferenceCheckReport => ({
  target: { kind: "library" },
  checkedAt: "2026-11-10T12:00:00.000Z",
  files: [],
  references: 2,
  citations: 0,
  checked: 2,
  noIdentifier: 0,
  unavailable: 0,
  complete: true,
  findings,
  omittedFindings: 0,
  ledger: [],
  notes: [],
});

function setup(findings: ReadonlyArray<ScientReferenceFinding>) {
  mocks.checkReferences.mockReset().mockResolvedValue(report(findings));
  mocks.readReferenceDocuments.mockReset().mockResolvedValue({ paths: [], truncated: false });
  mocks.resolveReferences.mockReset();
  return { onClose: vi.fn() };
}

describe("ReferenceCheckDialog", () => {
  it("checks on open, applies a registry fix and ignores a finding", async () => {
    const { onClose } = setup([
      finding({
        findingId: "ghost",
        kind: "identifier-not-found",
        severity: "problem",
        key: "ghost",
        message: "DOI 10.1000/missing was not found at doi.org.",
      }),
      finding({
        findingId: "year",
        key: "smith2020",
        location: { path: "refs.bib", line: 3 },
        message: "The year is 2020 here; the registry has 2021.",
        fix: yearFix,
      }),
    ]);
    await using _screen = await render(
      <ReferenceCheckDialog
        environmentId={environmentId}
        root="/project"
        initialTarget={{ kind: "library" }}
        onClose={onClose}
      />,
    );

    await expect.element(page.getByText("1 problem, 1 warning in 2 references.")).toBeVisible();
    expect(mocks.checkReferences).toHaveBeenCalledTimes(1);
    expect(mocks.checkReferences).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      target: { kind: "library" },
    });

    mocks.resolveReferences.mockResolvedValueOnce({
      fixes: [{ index: 0, outcome: "applied", message: "Set smith2020's year in refs.bib." }],
      ignored: [],
      restored: [],
    });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.element(page.getByText("Fixed")).toBeVisible();
    expect(mocks.resolveReferences).toHaveBeenLastCalledWith(environmentId, {
      root: "/project",
      apply: [yearFix],
    });

    mocks.resolveReferences.mockResolvedValueOnce({ fixes: [], ignored: ["ghost"], restored: [] });
    await page.getByRole("button", { name: "Ignore" }).first().click();
    await expect.element(page.getByText("1 warning in 2 references.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Show 1 ignored" })).toBeVisible();
    expect(mocks.resolveReferences).toHaveBeenLastCalledWith(environmentId, {
      root: "/project",
      ignore: ["ghost"],
    });
  });

  it("keeps a fix that went stale and says why", async () => {
    const { onClose } = setup([finding({ findingId: "year", key: "smith2020", fix: yearFix })]);
    mocks.resolveReferences.mockResolvedValueOnce({
      fixes: [
        {
          index: 0,
          outcome: "stale",
          message: "smith2020's year changed since the check. Check the references again.",
        },
      ],
      ignored: [],
      restored: [],
    });
    await using _screen = await render(
      <ReferenceCheckDialog
        environmentId={environmentId}
        root="/project"
        initialTarget={{ kind: "file", path: "refs.bib" }}
        onClose={onClose}
      />,
    );

    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect
      .element(
        page.getByText("smith2020's year changed since the check. Check the references again."),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  });
});
