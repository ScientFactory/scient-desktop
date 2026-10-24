import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ModelOption } from "../../lib/modelOptions";
import type { ExistingThreadSettingsRouteSession } from "./ThreadSettingsSheet";
import { makeThreadShellFixture } from "../../test-fixtures";

const composer = vi.hoisted(() => ({
  text: "Saved draft",
  setText: vi.fn(),
  present: vi.fn(),
  open: vi.fn(),
  inventory: vi.fn(),
  model: vi.fn(),
  runtime: vi.fn(),
  remember: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 35 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Keyboard: { dismiss: vi.fn() },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const transition = {
    duration: () => transition,
    delay: () => transition,
    reduceMotion: () => transition,
  };
  return {
    default: { View, createAnimatedComponent: (component: unknown) => component },
    FadeIn: transition,
    FadeOut: transition,
    ReduceMotion: { System: "system" },
    useAnimatedStyle: () => ({}),
    withTiming: (value: number) => value,
    useSharedValue: (initial: number) => {
      const ref = useRef({
        value: initial,
        set(value: number) {
          this.value = value;
        },
      });
      return ref.current;
    },
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ addListener: () => () => {}, dispatch: vi.fn() }),
  useFocusEffect: () => {},
  StackActions: { push: vi.fn() },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/GlassSurface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ComposerModelControl", () => ({
  ComposerModelControl: ({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) => (
    <button aria-label="Model settings" onClick={onPress} disabled={disabled}>
      Model settings
    </button>
  ),
}));
vi.mock("../../components/ComposerEditor", () => ({ ComposerEditor: () => null }));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerActionButton: () => null,
  ComposerToolbarRow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
  ComposerAttachmentThumbnail: () => null,
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../lib/composerImageGallery", () => ({ composerImageGallery: {} }));
vi.mock("../../lib/filePreviewGallery", () => ({ filePreviewGallery: {} }));
vi.mock("../../lib/composerImages", () => ({ composerStripAttachments: () => [] }));
vi.mock("../../lib/mobileTheme", () => ({ themeColorWithAlpha: () => "#ffffff" }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
  isModelSelectionUnavailable: () => false,
}));
vi.mock("../../lib/providerOptions", () => ({ resolveProviderOptionDescriptors: () => [] }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/entities", () => ({ useProject: () => null, useThreadShells: () => [] }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("../../state/scientSkills", () => ({
  scientSkillsInventory: (input: unknown) => {
    composer.inventory(input);
    return {};
  },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  composerDraftsAtom: {},
  composerContextImportsAtom: {},
  countComposerDraftAttachmentsAfterSelection: () => 0,
  useComposerDraft: () => ({ text: composer.text, attachments: [] }),
  getComposerDraftSnapshot: () => ({ text: composer.text, attachments: [] }),
  setComposerDraftText: (key: string, text: string) => {
    composer.setText(key, text);
    composer.text = text;
  },
}));
vi.mock("../../state/composer-attachment-uploads", () => ({
  composerAttachmentUploadsAtom: {},
  composerAttachmentsStillUploading: () => false,
  composerAttachmentUploadBlockReason: () => null,
}));
vi.mock("../../state/use-model-option-memory", () => ({
  withRememberedModelOptions: (value: unknown) => value,
  rememberModelOptions: composer.remember,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ setComposerEditing: () => {} }),
}));
vi.mock("../workspace/useSystemWorkspaceTabBar", () => ({ useSidebarWorkspaceTabs: () => "none" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 24 }),
}));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  armAgentAwarenessLiveActivityForLocalWork: vi.fn(),
}));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: () => ({ state: { phase: "idle" }, elapsedSeconds: 0 }),
}));
vi.mock("../voice-input/ComposerDictationControl", () => ({
  ComposerDictationCancelAction: () => null,
  ComposerDictationDraftContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ComposerDictationPrimaryAction: () => null,
  ComposerDictationStartAction: () => null,
  ComposerDictationStatus: () => null,
  ComposerDictationToolbar: () => null,
}));
vi.mock("./ComposerAttachmentButton", () => ({ ComposerAttachmentButton: () => null }));
vi.mock("./ComposerQueuedEdit", () => ({ ComposerQueuedEditAttachments: () => null }));
vi.mock("./ComposerPopoverAnchor", () => ({ ComposerPopoverAnchor: () => null }));
vi.mock("./ComposerCommandPopover", () => ({ ComposerCommandPopover: () => null }));
vi.mock("./use-composer-command-menu", () => ({
  useComposerCommandMenu: () => ({ trigger: null }),
}));
vi.mock("./ThreadSettingsSheet", () => ({
  useExistingThreadSettingsRoutePresentation: () => ({ present: composer.present, clear: vi.fn() }),
}));
vi.mock("./use-thread-settings-sheet-presentation", () => ({
  useThreadSettingsSheetPresentation: () => ({ open: composer.open }),
}));

import { ThreadComposer, type ThreadComposerProps } from "./ThreadComposer";

function setup() {
  vi.clearAllMocks();
  composer.text = "Saved draft";
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const thread = makeThreadShellFixture({
    environmentId: EnvironmentId.make("environment"),
    id: ThreadId.make("synthetic-thread"),
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
  });
  const props: ThreadComposerProps = {
    isDraft: true,
    draftKey: "new-task",
    canOperateThread: true,
    placeholder: "Draft",
    connectionState: "offline",
    environmentLabel: null,
    selectedThread: thread,
    environmentId: thread.environmentId,
    hasCompactableConversation: false,
    serverConfig: null,
    queueCount: 0,
    activeThreadBusy: false,
    canStopThread: false,
    projectCwd: null,
    followUpBehavior: "queue",
    canSteerActiveTurn: false,
    hidden: false,
    onChangeDraftMessage: vi.fn(),
    onPickDraftMedia: vi.fn(),
    onPickDraftFiles: vi.fn(),
    onNativePasteImages: vi.fn(),
    onNativePasteText: vi.fn(),
    onRemoveDraftImage: vi.fn(),
    onStopThread: vi.fn(),
    onResumeQueue: null,
    onSendMessage: vi.fn(),
    onShowUsageLimits: vi.fn(),
    canSwitchProvider: true,
    onUpdateModelSelection: composer.model,
    onUpdateRuntimeMode: composer.runtime,
  };
  const render = (overrides: Partial<ThreadComposerProps> = {}) =>
    act(() => root.render(<ThreadComposer {...props} {...overrides} />));
  render();
  return {
    render,
    thread,
    container,
    modelButton: () => container.querySelector<HTMLButtonElement>('[aria-label="Model settings"]')!,
    [Symbol.dispose]() {
      act(() => root.unmount());
      globals.IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}

describe("shared draft composer runtime", () => {
  it("queries project skills without asking the server to resolve its synthetic thread", () => {
    using screen = setup();
    expect(composer.inventory).toHaveBeenLastCalledWith({
      environmentId: screen.thread.environmentId,
      input: { projectId: screen.thread.projectId },
    });
    screen.render({ isDraft: false });
    expect(composer.inventory).toHaveBeenLastCalledWith({
      environmentId: screen.thread.environmentId,
      input: { projectId: screen.thread.projectId, threadId: screen.thread.id },
    });
  });

  it("locks settings entry and already-presented prompt/model callbacks while a share imports", () => {
    using screen = setup();
    act(() => screen.modelButton().click());
    const session = composer.present.mock.lastCall![0] as ExistingThreadSettingsRouteSession;
    screen.render({ interactionLocked: true });
    expect(screen.modelButton().disabled).toBe(true);
    act(() => {
      session.onPromptChange("Lost edit");
      session.onSelectModel({ selection: screen.thread.modelSelection } as ModelOption);
      session.onUpdateRuntimeMode("approval-required");
      session.onUpdateOptionSelections([]);
    });
    expect(composer.text).toBe("Saved draft");
    expect(composer.setText).not.toHaveBeenCalled();
    expect(composer.model).not.toHaveBeenCalled();
    expect(composer.runtime).not.toHaveBeenCalled();
    expect(composer.remember).not.toHaveBeenCalled();
    const opens = composer.open.mock.calls.length;
    act(() => screen.modelButton().click());
    expect(composer.open).toHaveBeenCalledTimes(opens);
    screen.render({ interactionLocked: false });
    act(() => session.onPromptChange("Kept edit"));
    expect(composer.text).toBe("Kept edit");
  });

  it("does not let a previous draft's settings mutate it after changing draft owners", () => {
    using screen = setup();
    act(() => screen.modelButton().click());
    const session = composer.present.mock.lastCall![0] as ExistingThreadSettingsRouteSession;
    screen.render({ draftKey: "another-new-task" });
    act(() => session.onPromptChange("Stale edit"));
    expect(composer.setText).not.toHaveBeenCalled();
  });
});
