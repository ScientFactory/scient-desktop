import { EnvironmentId, ProjectId, type WordsCommand } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WordsEditor, WordsScopes } from "./WordsEditor";
import { WordsSettingsSection } from "./WordsPanel";
import "../../index.css";

const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const revisionId = "2026-11-22-lecture-abcdef01";
const suggestion = { term: "שלום", language: "he", source: "user" } as const;
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => run }));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useProjects: () => [{ environmentId: remote, id: projectId, title: "Remote Project" }],
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));

it("opens Words for the selected environment and accepts a recording suggestion into each scope", async () => {
  run.mockImplementation(async ({ input }: { input: WordsCommand }) => ({
    _tag: "Success",
    value:
      input.action === "recordings-list"
        ? { recordings: [{ id: revisionId, title: "Lecture" }] }
        : {
            words:
              input.action === "suggestions-list" || input.action === "words-accept"
                ? [suggestion]
                : [],
          },
  }));
  await using screen = await render(<WordsSettingsSection />);
  const project = screen.getByRole("combobox", { name: "Project for Words" });
  await expect.element(project).toHaveTextContent("Personal");
  await project.click();
  await page.getByRole("option", { name: "Remote Project" }).click();
  await expect
    .poll(() =>
      run.mock.calls.some(
        ([call]) =>
          call.environmentId === remote &&
          call.input.action === "words-list" &&
          call.input.level === "project",
      ),
    )
    .toBe(true);
  const recording = screen.getByRole("combobox", { name: "Recording" });
  await expect.element(recording).toHaveTextContent("Whole project");
  await recording.click();
  await page.getByRole("option", { name: "Lecture" }).click();
  for (const [button, level] of [
    ["Recording", "recording"],
    ["Project", "project"],
    ["Yours", "global"],
  ] as const) {
    if (level !== "recording") await userEvent.click(screen.getByRole("button", { name: button }));
    await userEvent.click(screen.getByRole("button", { name: "Accept שלום" }));
    expect(run).toHaveBeenCalledWith(
      {
        environmentId: remote,
        input: {
          action: "words-accept",
          level,
          projectId,
          id: revisionId,
          suggestionRevision: revisionId,
          word: suggestion,
        },
      },
      { signal: undefined },
    );
  }

  await project.click();
  await page.getByRole("option", { name: "Personal" }).click();
  await expect.element(project).toHaveTextContent("Personal");
  await expect.element(recording).not.toBeInTheDocument();
});

it("offers Recording Words only in a recording context", async () => {
  await using screen = await render(
    <WordsScopes yours={<span>Personal words</span>} project={<span>Project words</span>} />,
  );
  await expect.element(screen.getByText("Personal words")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Recording" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Project" }));
  await expect.element(screen.getByText("Project words")).toBeVisible();
  await screen.rerender(
    <WordsScopes
      yours={<span>Personal words</span>}
      project={<span>Project words</span>}
      recording={<span>Recording words</span>}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Recording" }));
  await expect.element(screen.getByText("Recording words")).toBeVisible();
});

it("lays words side by side at their own width and scrolls a long list", async () => {
  const words = Array.from({ length: 40 }, (_, index) => ({
    term: index % 3 ? `term${index}` : `a longer phrase ${index}`,
    language: "und",
    source: "user" as const,
  }));
  await page.viewport(420, 600);
  await using screen = await render(
    <div className="w-[360px] rounded-xl border bg-popover p-4">
      <WordsEditor label="word list" words={words} onSave={() => {}} onRemove={() => {}} />
    </div>,
  );
  const list = screen.getByRole("list", { name: "word list entries" }).element();
  const [first, second] = [...list.children].map((item) => item.getBoundingClientRect());
  expect(second!.top).toBe(first!.top);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  const directory = import.meta.env.VITE_SCIENT_RECORDINGS_SCREENSHOTS;
  if (directory) await page.screenshot({ path: `${directory}/words-chips.png` });
});
