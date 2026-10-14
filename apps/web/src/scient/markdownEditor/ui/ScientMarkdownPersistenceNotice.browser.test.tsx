import "../../../index.css";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { ProjectWriteFileError } from "@t3tools/contracts";

import type { MarkdownPersistenceLease } from "../persistence/markdownPersistenceRegistry";
import { ScientMarkdownPersistenceNotice } from "./ScientMarkdownPersistenceNotice";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  document.documentElement.classList.remove("dark");
});

const quiet = {
  attention: null,
  conflict: null,
  error: null,
  pending: false,
  currentMissing: false,
  publicationAttention: null,
  publicationOutcome: null,
  attentionMutationId: null,
  inFlight: false,
  reading: false,
  publicationIntent: null,
  recoverySource: null,
};
const diskFull = new ProjectWriteFileError({
  cwd: "C:\\Users\\someone\\ScientProjects\\Trials",
  relativePath: "templates/05_advanced_math.tex",
  failure: "operation_failed",
  osErrorCode: "ENOSPC",
  publicationOutcome: "unchanged",
});

/** The notice reads only its lease's snapshot; each state is drawn without a coordinator. */
async function show(name: string, snapshot: Readonly<Record<string, unknown>>) {
  await page.viewport(1100, 400);
  host = document.createElement("div");
  host.style.cssText = "width:1100px";
  document.body.append(host);
  root = createRoot(host);
  const current = { ...quiet, ...snapshot };
  const lease = {
    subscribe: () => () => {},
    getSnapshot: () => current,
    getPendingInput: () => null,
  } as unknown as MarkdownPersistenceLease;
  root.render(<ScientMarkdownPersistenceNotice persistence={lease} onOpenFile={() => {}} />);
  await expect.poll(() => host!.querySelector("[role=region]")).toBeTruthy();
  const directory = import.meta.env.VITE_SCIENT_SAVE_NOTICE_SCREENSHOTS;
  const element = host.querySelector<HTMLElement>("[role=region]")!;
  if (directory) await page.screenshot({ path: `${directory}/${name}.png`, element });
  return element;
}

it.each([
  [
    "refused",
    {
      attention: "outcome_unknown",
      error: diskFull,
      pending: true,
      publicationOutcome: "unchanged",
      attentionMutationId: "4d26d68b-af47-4345-8773-9e77d3f3bb4f",
    },
  ],
  ["failed", { error: new Error("offline"), pending: true }],
  ["conflict", { pending: true, conflict: { externalSource: "Newer", externalRevision: "r2" } }],
  ["missing", { currentMissing: true, pending: true }],
] as const)("draws the %s notice as one compact line", async (name, snapshot) => {
  const region = await show(name, snapshot);
  // One line of text and buttons, not a block of paragraphs.
  expect(region.getBoundingClientRect().height).toBeLessThanOrEqual(44);
  expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  expect(region.textContent).not.toContain("mutation");
});

it("opens technical details beneath the line and keeps them out of the sentence", async () => {
  document.documentElement.classList.add("dark");
  const region = await show("refused-dark", {
    attention: "outcome_unknown",
    error: diskFull,
    pending: true,
    publicationOutcome: "unchanged",
    attentionMutationId: "4d26d68b-af47-4345-8773-9e77d3f3bb4f",
  });
  expect(region.textContent).toContain("Couldn’t save: the disk is full.");
  expect(region.textContent).not.toContain("05_advanced_math");
  await page.getByRole("button", { name: "Details" }).click();
  await expect.element(page.getByText(/Code: ENOSPC/)).toBeVisible();
  expect(region.textContent).toContain("Save reference: 4d26d68b");
  const directory = import.meta.env.VITE_SCIENT_SAVE_NOTICE_SCREENSHOTS;
  if (directory)
    await page.screenshot({ path: `${directory}/refused-details-dark.png`, element: region });
});
