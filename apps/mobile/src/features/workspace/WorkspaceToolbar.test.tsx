import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { assert } from "@effect/vitest";
import { it, vi } from "vite-plus/test";

const layout = vi.hoisted(() => ({ device: "pad", split: false, compose: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));
vi.mock("../../state/active-new-task", () => ({ useActiveNewTask: () => null }));
vi.mock("../../components/ui/Toolbar", () => ({
  Toolbar: Object.assign(({ children }: { children?: ReactNode }) => <div>{children}</div>, {
    Button: (props: { accessibilityLabel: string; onPress: () => void }) => (
      <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
    ),
    Spacer: () => null,
    SearchBarSlot: () => null,
  }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  useAnimatedStyle: () => ({}),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/native-layout-metrics", () => ({
  useDeviceType: () => layout.device,
  useDuoBottomBarInset: () => 0,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: true }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: () => {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: layout.split },
    panes: {},
    togglePrimarySidebar: vi.fn(),
  }),
}));
vi.mock("./WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({
    state: { selectedTab: "threads", tabs: { threads: { searchMode: "resting", query: "" } } },
    isTabActive: () => true,
  }),
}));
vi.mock("./WorkspaceSearchField", () => ({ WorkspaceSearchField: () => null }));
vi.mock("./useSystemWorkspaceTabBar", () => ({
  useSidebarWorkspaceTabs: () => null,
  // As on iOS: the compact glass picker owns compose off iPad, Duo and split view.
  useCompactWorkspaceTabs: () =>
    layout.device !== "pad" && !layout.split && !layout.device.startsWith("duo"),
}));
vi.mock("./WorkspaceSectionToolbar", () => ({ WorkspaceTabToolbarButtons: () => null }));
vi.mock("./useSelectWorkspaceTab", () => ({ useSelectWorkspaceTab: () => vi.fn() }));
vi.mock("../../lib/useMobileNavigationTheme", () => ({
  useMobileNavigationTheme: () => ({ colors: { primary: "blue" } }),
}));

// One row per branch of the compact-ipad-compose rule; other devices share the phone row.
it.each([
  { device: "pad", split: false, compose: true },
  { device: "pad", split: true, compose: false },
  { device: "duo-folded", split: false, compose: true },
  { device: "phone", split: false, compose: false },
])("keeps the touch compose entry for $device split=$split", async (pose) => {
  layout.device = pose.device;
  layout.split = pose.split;
  layout.compose.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // This component's one require is a bundled PNG; no native asset loader is needed.
  vi.stubGlobal("require", () => 0);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  using _mounted = {
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
  const { WorkspaceToolbar } = await import("./WorkspaceToolbar.ios");
  act(() => root.render(<WorkspaceToolbar onNewTask={layout.compose} />));
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
  assert.strictEqual(button !== null, pose.compose);
  if (button) {
    act(() => button.click());
    assert.strictEqual(layout.compose.mock.calls.length, 1);
  }
});
