import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { ImportTranscriptDialog } from "./ImportTranscriptDialog";
import type { Project } from "./recordingTypes";

const mocks = vi.hoisted(() => ({
  command: vi.fn(async (action: string) => {
    if (action === "inventory") return { local: [{ id: "whisper", installed: true }] };
    if (action === "assess-subtitles")
      return {
        assessment: {
          quality: {
            subtitleLanguage: "he",
            coverage: 0.96,
            wordErrorRate: 0.02,
            recommendation: "use-subtitles",
          },
        },
      };
    return {};
  }),
}));
vi.mock("../../rpc/transcription", () => ({ transcriptionCommand: mocks.command }));

it("shows quality before importing against media and retains the recording revision", async () => {
  const project = { id: "class", workspaceRoot: "/class", title: "Quantum course" } as Project;
  const file = new File(["WEBVTT"], "Hebrew lecture.vtt");
  const matched = { project, source: "/class/lecture.mp4", revision: "previous" };
  const imported = vi.fn();
  const copy = vi.fn(async () => "/class/Hebrew lecture.vtt");
  await using _screen = await render(
    <ImportTranscriptDialog
      file={file}
      projects={[project]}
      selectedProject={project}
      media={[matched]}
      matched={matched}
      copy={copy}
      onClose={() => {}}
      onImported={imported}
    />,
  );
  await page.getByRole("button", { name: "Check quality" }).click();
  await expect.element(page.getByText(/96% speech coverage/)).toBeVisible();
  const directory = import.meta.env.VITE_SCIENT_RECORDINGS_SCREENSHOTS;
  if (directory) {
    await page.screenshot({ path: `${directory}/import-transcript.png` });
    document.documentElement.classList.add("dark");
    try {
      await page.screenshot({ path: `${directory}/import-transcript-dark.png` });
    } finally {
      document.documentElement.classList.remove("dark");
    }
  }
  await page.getByRole("button", { name: "Import transcript" }).click();
  await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
  expect(copy).toHaveBeenCalledOnce();
  expect(mocks.command).toHaveBeenCalledWith("import-transcript", "/class", {
    file: "/class/Hebrew lecture.vtt",
    source: "/class/lecture.mp4",
    previousId: "previous",
  });
});
