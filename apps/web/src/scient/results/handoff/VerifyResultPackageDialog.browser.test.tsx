import "../../../index.css";

import { EnvironmentId, type ResultHandoffVerifyResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { VerifyResultPackageDialog } from "./VerifyResultPackageDialog";

const verify = vi.hoisted(() => vi.fn());
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: () => verify,
}));

it("shows unmatched outputs immediately and lets the reader expand matched outputs", async () => {
  await using viewport = new AsyncDisposableStack();
  const prior = {
    width: innerWidth,
    height: innerHeight,
    dark: document.documentElement.classList.contains("dark"),
  };
  viewport.defer(async () => {
    document.documentElement.classList.toggle("dark", prior.dark);
    await page.viewport(prior.width, prior.height);
  });
  verify.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      report: {
        version: 1,
        revision: null,
        verifiedAt: "2026-11-23T08:00:00Z",
        status: "differs",
        absoluteTolerance: 1e-12,
        relativeTolerance: 1e-9,
        outputs: [
          { path: "confusion.csv", status: "matched" },
          {
            path: "metrics.json",
            status: "differs",
            differenceCount: 1,
            values: [
              {
                pointer: "/n",
                expected: "10",
                actual: "11",
                absoluteDifference: 1,
                relativeDifference: 0.1,
              },
            ],
          },
          { path: "undelivered.png", status: "unchecked" },
        ],
        files: [{ path: "sample.csv", status: "missing", separatelySupplied: true }],
        environment: null,
        environmentChanges: [{ name: "numpy", recorded: "2.4.5", rerun: "2.4.6" }],
      },
      reportPath: "/project/verification/verification.json",
      figures: [],
    } satisfies ResultHandoffVerifyResult,
  });
  // The verification dialog does not navigate.
  await using _screen = await render(
    <VerifyResultPackageDialog
      environmentId={EnvironmentId.make("fixture")}
      cwd="/project"
      open
      onClose={() => {}}
      onReopen={() => {}}
    />,
    { router: false },
  );
  const folder = page.getByRole("textbox", { name: "Package folder" });
  const run = page.getByRole("button", { name: "Run and verify" });
  const settings = page.getByRole("button", { name: /Verification settings/ });
  const timeLimit = page.getByRole("textbox", { name: "Rerun time limit (minutes)" });
  const supplied = page.getByRole("textbox", { name: "Folder with separately supplied inputs" });
  await expect.element(run).toBeDisabled();
  await expect.element(page.getByRole("alert").filter({ hasText: "trust the code" })).toBeVisible();
  await expect
    .element(settings.getByText("Automatic runtime · 60 min", { exact: true }))
    .toBeVisible();
  await expect.element(timeLimit).not.toBeInTheDocument();
  await expect.element(supplied).not.toBeInTheDocument();
  const captures = import.meta.env.VITE_SCIENT_HANDOFF_CAPTURES;
  if (captures) {
    for (const width of [540, 360]) {
      await page.viewport(width, 780);
      for (const theme of ["light", "dark"]) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        await page.screenshot({ path: `${captures}/verify-${width}-${theme}.png` });
      }
    }
    document.documentElement.classList.remove("dark");
  }
  await folder.fill("/project/package");
  await userEvent.tab();
  await userEvent.tab();
  await expect.element(settings).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(timeLimit).toHaveValue("60");
  await timeLimit.fill("0");
  await expect.element(run).toBeDisabled();
  await timeLimit.fill("45");
  await run.click();
  expect(verify.mock.lastCall?.[0].input.timeoutMinutes).toBe(45);
  await expect.element(page.getByText("metrics.json", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(/absolute difference 1.*relative difference 0.1/))
    .toBeVisible();
  await expect.element(page.getByText(/Not compared/)).toBeVisible();
  await expect.element(page.getByText("confusion.csv", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText(/numpy changed/)).not.toBeInTheDocument();
  await page.getByText("1 matched output", { exact: true }).click();
  await expect.element(page.getByText("confusion.csv", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.element(supplied).toBeVisible();
  await supplied.fill("/project/source-data");
  await run.click();
  expect(verify.mock.lastCall?.[0].input.inputsFolder).toBe("/project/source-data");
});

it("distinguishes matched evidence with differing figures and completed figure-only reruns", async () => {
  verify
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        report: {
          version: 1,
          revision: null,
          verifiedAt: "2026-11-23T08:00:00Z",
          status: "verified",
          message:
            "Checked values, tables, and data files matched. Figures differ and need visual review.",
          absoluteTolerance: 1e-12,
          relativeTolerance: 1e-9,
          outputs: [
            { path: "metrics.json", status: "matched" },
            { path: "roc.png", status: "differs", message: "Figure bytes differ." },
          ],
          files: [],
          environment: {
            language: "Python",
            version: "3.12.13",
            platform: "darwin",
            architecture: "arm64",
            locale: "en_US.UTF-8",
            timezone: "UTC",
          },
          environmentChanges: [],
        },
        reportPath: "/project/verification/verification.json",
        figures: [],
      } satisfies ResultHandoffVerifyResult,
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        report: {
          version: 1,
          revision: null,
          verifiedAt: "2026-11-23T08:01:00Z",
          status: "could-not-run",
          message:
            "The rerun finished with no retained values, tables, or data files to verify automatically. Review the differing figures.",
          absoluteTolerance: 1e-12,
          relativeTolerance: 1e-9,
          outputs: [{ path: "roc.png", status: "differs", message: "Figure bytes differ." }],
          files: [],
          environment: {
            language: "Python",
            version: "3.12.13",
            platform: "darwin",
            architecture: "arm64",
            locale: "en_US.UTF-8",
            timezone: "UTC",
          },
          environmentChanges: [],
        },
        reportPath: "/project/verification/verification.json",
        figures: [],
      } satisfies ResultHandoffVerifyResult,
    });
  // The verification dialog does not navigate.
  {
    await using _first = await render(
      <VerifyResultPackageDialog
        environmentId={EnvironmentId.make("fixture")}
        cwd="/project"
        open
        onClose={() => {}}
        onReopen={() => {}}
      />,
      { router: false },
    );
    await page.getByRole("textbox", { name: "Package folder" }).fill("/project/package-1");
    await page.getByRole("button", { name: "Run and verify" }).click();
    await expect
      .element(
        page
          .getByRole("status")
          .filter({ hasText: "Checked outputs matched · figures need review" }),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
  }

  await using _second = await render(
    <VerifyResultPackageDialog
      environmentId={EnvironmentId.make("fixture")}
      cwd="/project"
      open
      onClose={() => {}}
      onReopen={() => {}}
    />,
    { router: false },
  );
  await page.getByRole("textbox", { name: "Package folder" }).fill("/project/package-2");
  await page.getByRole("button", { name: "Run and verify" }).click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Rerun finished · figures need review" }))
    .toBeVisible();
  await expect.element(page.getByText("Could not run")).not.toBeInTheDocument();
});
