import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const queue = vi.hoisted(() => ({
  held: true,
  eligible: true,
  canSendNow: true,
  canPromoteToSteer: false,
  editing: false,
  resume: vi.fn(async () => {}),
  promote: vi.fn(async () => {}),
  actions: [] as Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>,
  onAction: (_id: string) => {},
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn() }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Pressable: ({
      children,
      accessibilityLabel,
      disabled,
      onPress,
    }: {
      children?: ReactNode;
      accessibilityLabel?: string;
      disabled?: boolean;
      onPress?: () => void;
    }) => (
      <div
        role="button"
        aria-label={accessibilityLabel}
        aria-disabled={!!disabled}
        onClick={disabled ? undefined : onPress}
      >
        {children}
      </div>
    ),
    Animated: {
      View,
      Value: class {
        setValue() {}
      },
    },
    Platform: { OS: "android", Version: 35 },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  useAnimatedStyle: () => ({}),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-screens", () => ({}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    children,
    actions,
    onPressAction,
  }: {
    children?: ReactNode;
    actions: typeof queue.actions;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => {
    queue.actions = actions;
    queue.onAction = (event) => onPressAction({ nativeEvent: { event } });
    return <div>{children}</div>;
  },
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/assetImageSource", () => ({ assetImageSource: vi.fn() }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  nativeHeaderScrollEdgeEffects: () => ({}),
}));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("../../state/queued-run-edit", () => ({
  beginQueuedRunEdit: vi.fn(),
  useQueuedRunEdit: () => (queue.editing ? { runId: "queued" } : null),
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    queueWorkflowAtom: () => ({
      queuedRuns: [{ run: { id: "queued" }, text: "Queued prompt", attachments: [] }],
      isHeld: queue.held,
      canSendNow: queue.canSendNow,
      canPromoteToSteer: queue.canPromoteToSteer,
      canReorder: false,
      activeRun: queue.canPromoteToSteer ? { id: "active" } : null,
    }),
  },
  threadEnvironment: {
    resumeThreadQueue: "resume",
    promoteQueuedRun: "promote",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "resume" ? queue.resume : command === "promote" ? queue.promote : vi.fn(),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./scientQueuedRunSend", () => ({
  useScientQueuedRunSendEvidence: () => ({}),
  // The policy itself has separate projection/shell tests. Here an ineligible
  // held row must not acquire an ordinary idle-queue action from its host.
  canSendScientQueuedRow: ({ isHeld, isEditing }: { isHeld: boolean; isEditing: boolean }) =>
    isHeld && queue.eligible && !isEditing,
}));

import { ThreadQueueSheet } from "./ThreadQueueControl";

function setup(
  options: Partial<
    Pick<typeof queue, "held" | "eligible" | "editing" | "canSendNow" | "canPromoteToSteer">
  > = {},
) {
  Object.assign(queue, {
    held: true,
    eligible: true,
    canSendNow: true,
    canPromoteToSteer: false,
    editing: false,
    ...options,
  });
  vi.clearAllMocks();
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThreadQueueSheet
        route={{
          params: {
            environmentId: EnvironmentId.make("environment"),
            threadId: ThreadId.make("thread"),
          },
        }}
      />,
    ),
  );
  return {
    container,
    [Symbol.dispose]() {
      act(() => root.unmount());
      globals.IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}

describe("mobile queue sheet Send eligibility", () => {
  it("offers no ordinary Send fallback for a held usage-limited row", async () => {
    using screen = setup({ eligible: false });
    expect(screen.container.querySelectorAll('[aria-label="Send message 1 now"]')).toHaveLength(0);
    expect(queue.actions.filter(({ id }) => id === "send" || id === "steer")).toEqual([]);
    await act(async () => queue.onAction("steer"));
    expect(queue.resume).not.toHaveBeenCalled();
  });

  it("offers exactly one Send action for an eligible held row", async () => {
    using screen = setup();
    expect(screen.container.querySelectorAll('[aria-label="Send message 1 now"]')).toHaveLength(1);
    expect(queue.actions.filter(({ id }) => id === "send" || id === "steer")).toEqual([
      expect.objectContaining({ id: "send" }),
    ]);
    await act(async () => queue.onAction("send"));
    expect(queue.resume).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      threadId: "thread",
      input: { threadId: "thread", runId: RunId.make("queued") },
    });
  });

  it("retains ordinary stopped-queue Send now", async () => {
    using screen = setup({ held: false });
    const button = screen.container.querySelector<HTMLElement>('[aria-label="Send message 1 now"]');
    expect(button?.getAttribute("aria-disabled")).toBe("false");
    await act(async () => button!.click());
    expect(queue.resume).toHaveBeenCalledOnce();
  });

  it("retains ordinary running-queue Steer", async () => {
    using screen = setup({ held: false, canSendNow: false, canPromoteToSteer: true });
    await act(async () =>
      screen.container
        .querySelector<HTMLElement>('[aria-label="Steer with message 1 now"]')!
        .click(),
    );
    expect(queue.promote).toHaveBeenCalledOnce();
    expect(queue.resume).not.toHaveBeenCalled();
  });

  it("does not send the row currently being edited", () => {
    using screen = setup({ editing: true });
    expect(screen.container.querySelectorAll('[aria-label="Send message 1 now"]')).toHaveLength(0);
    expect(queue.actions.some(({ id }) => id === "send" || id === "steer")).toBe(false);
  });
});
