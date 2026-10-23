import { render as _fixtureRender, type Screen } from "../../../../test/render";
import "../../../index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { ProjectWriteFileError } from "@t3tools/contracts";

import type { MarkdownPersistenceLease } from "../persistence/markdownPersistenceRegistry";
import { ScientMarkdownPersistenceNotice } from "./ScientMarkdownPersistenceNotice";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  document.documentElement.classList.remove("dark");
}

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
async function show(_fixture: _Fixture, name: string, snapshot: Readonly<Record<string, unknown>>) {
  await page.viewport(1100, 400);
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:1100px";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  const current = { ...quiet, ...snapshot };
  const lease = {
    subscribe: () => () => {},
    getSnapshot: () => current,
    getPendingInput: () => null,
  } as unknown as MarkdownPersistenceLease;
  await _fixture.root0.rerender(
    <ScientMarkdownPersistenceNotice persistence={lease} onOpenFile={() => {}} />,
  );
  await expect.poll(() => _fixture.host!.querySelector("[role=region]")).toBeTruthy();
  const directory = import.meta.env.VITE_SCIENT_SAVE_NOTICE_SCREENSHOTS;
  const element = _fixture.host.querySelector<HTMLElement>("[role=region]")!;
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const region = await show(_fixture, name, snapshot);
  // One line of text and buttons, not a block of paragraphs.
  expect(region.getBoundingClientRect().height).toBeLessThanOrEqual(44);
  expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  expect(region.textContent).not.toContain("mutation");
});

it("opens technical details beneath the line and keeps them out of the sentence", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  document.documentElement.classList.add("dark");
  const region = await show(_fixture, "refused-dark", {
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
