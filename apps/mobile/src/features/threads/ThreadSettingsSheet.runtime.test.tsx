// @vitest-environment happy-dom
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ModelOption } from "../../lib/modelOptions";

const native = vi.hoisted(() => ({
  navigate: vi.fn(),
  goBack: vi.fn(),
  page: "ThreadSettingsModels",
  params: { kind: "runtime", title: "Runtime" },
}));
vi.mock("@react-navigation/native-stack", async () => {
  const { createContext, use, useState } = await import("react");
  const route = createContext("ThreadSettingsModels");
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: { children: ReactNode }) => {
        const [page, setPage] = useState(native.page);
        native.navigate.mockImplementation((next, params) => {
          native.params = params;
          setPage(next);
        });
        native.goBack.mockImplementation(() => setPage("ThreadSettingsModels"));
        return <route.Provider value={page}>{children}</route.Provider>;
      },
      Screen: ({ name, component: Screen }: { name: string; component: ComponentType }) =>
        use(route) === name ? <Screen /> : null,
    }),
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => native,
  useRoute: () => ({ params: native.params }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ _tag: "Initial" }),
  useAtomSet: () => vi.fn(),
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: () => undefined }));
vi.mock("../../state/use-model-option-memory", () => ({ rememberModelOptions: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: 17 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  TextInput: () => null,
  RefreshControl: () => null,
  Alert: { alert: vi.fn() },
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition, delay: () => transition };
  return {
    default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
    FadeIn: transition,
    FadeOut: transition,
    LinearTransition: transition,
  };
});
vi.mock("@legendapp/list/reanimated", () => ({
  AnimatedLegendList: ({
    data,
    renderItem,
  }: {
    data: readonly { key: string }[];
    renderItem: (input: { item: { key: string }; index: number }) => ReactNode;
  }) => (
    <>
      {data.map((item, index) => (
        <div key={item.key}>{renderItem({ item, index })}</div>
      ))}
    </>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("../../components/MaterialButton", () => ({ MaterialButton: () => null }));
vi.mock("../../components/MaterialIconButton", () => ({ MaterialIconButton: () => null }));
vi.mock("../../components/MaterialScreenContent", () => ({
  MaterialScreenContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../native/StackHeader", () => ({
  NativeHeaderToolbar: Object.assign(() => null, {
    Button: () => null,
    Menu: () => null,
    Label: () => null,
    MenuAction: () => null,
  }),
  NativeStackScreenOptions: () => null,
  nativeHeaderScrollEdgeEffects: () => undefined,
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: false,
}));
vi.mock("./ChatGptSharingStatus", () => ({ ChatGptSharingStatus: () => null }));
vi.mock("./ThreadSettingsRows", () => ({
  ModelRow: () => null,
  ChoiceRow: ({
    label,
    selected,
    onPress,
  }: {
    label: string;
    selected: boolean;
    onPress: () => void;
  }) => (
    <button aria-pressed={selected} onClick={onPress}>
      {label}
    </button>
  ),
}));

import { ThreadSettingsPickerScreen } from "./ThreadSettingsSheet";

const grok: ModelOption = {
  key: "grok:test",
  label: "Grok",
  subtitle: "",
  providerKey: "grok",
  providerLabel: "Grok",
  providerDriver: "grok",
  isDefault: true,
  isLegacy: false,
  capabilities: null,
  selection: { instanceId: ProviderInstanceId.make("grok"), model: "test-model" },
  // The shipped Grok snapshot excludes Auto-accept edits (GrokAcpSupport).
  supportedRuntimeModes: ["approval-required", "auto", "full-access"],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  native.page = "ThreadSettingsModels";
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function open(runtimeMode: RuntimeMode, model = grok) {
  const update = vi.fn();
  await act(() =>
    root.render(
      <ThreadSettingsPickerScreen
        environmentId={null}
        providerGroups={[{ providerKey: "grok", providerLabel: "Grok", models: [model] }]}
        selectedModel={model.selection}
        onSelectModel={vi.fn()}
        optionDescriptors={[]}
        onUpdateOptionSelections={vi.fn()}
        runtimeMode={runtimeMode}
        onUpdateRuntimeMode={update}
        onClose={vi.fn()}
      />,
    ),
  );
  return update;
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return found;
}
it("shows unsupported requested access without choosing or persisting another mode", async () => {
  const update = await open("auto-accept-edits");
  expect(container.textContent).toContain("Choose access");
  expect(update).not.toHaveBeenCalled();
  await act(() => button("RuntimeChoose access").click());
  expect([...container.querySelectorAll("button[aria-pressed='true']")]).toEqual([]);
  expect(container.textContent).not.toContain("Auto-accept edits");
  expect(update).not.toHaveBeenCalled();
  await act(() => button("Supervised").click());
  expect(update).toHaveBeenCalledExactlyOnceWith("approval-required");
});
it("keeps a supported requested mode selected and only persists a deliberate choice", async () => {
  const update = await open("auto");
  await act(() => button("RuntimeAuto").click());
  expect(button("Auto").getAttribute("aria-pressed")).toBe("true");
  expect(update).not.toHaveBeenCalled();
  await act(() => button("Full access").click());
  expect(update).toHaveBeenCalledExactlyOnceWith("full-access");
});
it.each([{ modes: undefined }, { modes: [] }])(
  "keeps the existing unknown-capability choices usable: %j",
  async ({ modes }) => {
    const update = await open("auto", { ...grok, supportedRuntimeModes: modes });
    await act(() => button("RuntimeAuto").click());
    expect(button("Auto").getAttribute("aria-pressed")).toBe("true");
    expect(button("Auto-accept edits")).toBeDefined();
    expect(update).not.toHaveBeenCalled();
  },
);
