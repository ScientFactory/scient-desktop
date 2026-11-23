import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { resolveRecordingNotesModel } from "./RecordingNotes.ts";

it("prefers the project model, falls back to the chat default, and requests a picker when no usable model exists", () => {
  const project = { id: ProjectId.make("lecture") };
  const instanceId = ProviderInstanceId.make("codex");
  const defaultModelSelection = { instanceId, model: "default" };
  const projectModel = { instanceId, model: "project" };
  const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection };
  const provider = {
    instanceId,
    driver: "codex",
    enabled: true,
    models: [
      { slug: "default", name: "Default" },
      { slug: "project", name: "Project" },
    ],
  } as unknown as ServerProvider;
  expect(resolveRecordingNotesModel(settings, project, [provider], 0)).toEqual(
    defaultModelSelection,
  );
  expect(
    resolveRecordingNotesModel(
      settings,
      { ...project, defaultModelSelection: projectModel },
      [provider],
      0,
    ),
  ).toEqual(projectModel);
  expect(resolveRecordingNotesModel(settings, project, [], 0)).toBeNull();
});

it("replaces a retired stored model with the provider's actual default and never submits an empty catalog", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const project = { id: ProjectId.make("lecture") };
  const stored = { instanceId, model: "anthropic/claude-opus-5-5" };
  const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: stored };
  const provider = {
    instanceId,
    driver: "codex",
    enabled: true,
    models: [{ slug: "listed", name: "Listed", isDefault: true }],
  } as unknown as ServerProvider;
  expect(resolveRecordingNotesModel(settings, project, [provider], 0)).toEqual({
    instanceId,
    model: "listed",
  });
  expect(
    resolveRecordingNotesModel(settings, project, [{ ...provider, models: [] }], 0),
  ).toBeNull();
  expect(
    resolveRecordingNotesModel(settings, project, [{ ...provider, enabled: false }], 0),
  ).toBeNull();
  expect(resolveRecordingNotesModel(settings, project, [provider], 0, stored)).toBeNull();
});
