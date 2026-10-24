import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { assert } from "@effect/vitest";
import { it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  blocked: true,
  mounts: 0,
  unmounts: 0,
  guards: new Map<
    string,
    { preventNativeDismiss?: boolean; onNativeDismissPrevented?: () => void }
  >(),
  goBack: vi.fn(),
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  const primary = { key: "home", name: "Home" };
  const thread = { key: "thread", name: "Thread", params: { draft: {} } };
  const navigationState = {
    key: "workspace",
    index: 1,
    routes: [primary, thread],
    preloadedRoutes: [],
  };
  const navigation = {
    getState: () => navigationState,
    emit: vi.fn(),
    dispatch: vi.fn(),
    goBack: state.goBack,
  };
  const descriptors = {
    home: { route: primary, navigation, options: {}, render: () => null },
    thread: { route: thread, navigation, options: {}, render: () => <RetainedContent /> },
  };
  const NavigationContent = ({ children }: { children: ReactNode }) => children;
  return {
    NavigationContext: createContext(navigation),
    NavigationRouteContext: createContext(primary),
    StackRouter: () => {},
    useNavigationBuilder: () => ({
      state: navigationState,
      navigation,
      descriptors,
      NavigationContent,
    }),
    usePreventRemoveContext: () => ({
      preventedRoutes: state.blocked ? { thread: { preventRemove: true } } : {},
    }),
    createNavigatorFactory: (Navigator: unknown) => () => ({ Navigator }),
  };
});
vi.mock("@react-navigation/native-stack", () => ({
  NativeStackView: (props: {
    state: { routes: Array<{ key: string }> };
    descriptors: Record<string, { render: () => ReactNode }>;
  }) =>
    props.state.routes.map((route) => (
      <div key={route.key}>{props.descriptors[route.key]?.render()}</div>
    )),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-screens", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Split: {
      Host: Container,
      Column: Container,
      Stack: Container,
      Screen: Container,
      Inspector: Container,
      HeaderConfig: () => null,
    },
    Stack: {
      Host: Container,
      HeaderConfig: () => null,
      Screen: (props: {
        screenKey: string;
        children?: ReactNode;
        preventNativeDismiss?: boolean;
        onNativeDismissPrevented?: () => void;
      }) => {
        state.guards.set(props.screenKey, props);
        return <div>{props.children}</div>;
      },
    },
  };
});
vi.mock("../workspace/WorkspaceTabsContext", () => ({
  WorkspaceTabsProvider: ({ children }: { children: ReactNode }) => children,
  useWorkspaceTabs: () => ({ state: { selectedTab: "threads" } }),
}));
vi.mock("../workspace/WorkspaceNativeTabs.ios", () => ({
  WorkspaceNativeTabs: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: {},
    startNewTask: vi.fn(),
    togglePrimarySidebar: vi.fn(),
    toggleAuxiliaryPane: vi.fn(),
  }),
}));
vi.mock("../../native/native-layout-metrics", () => ({
  useDeviceType: () => "pad",
  useNativeLayoutMetrics: () => ({ verticalBarEdge: "none" }),
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsReady: () => true,
  useNativeWorkspaceColumnsSupported: () => true,
}));
vi.mock("../../native/NativeColumnContent.ios", () => ({
  NativeColumnContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../native/V5StackHeader.ios", () => ({ V5StackHeader: () => null }));
vi.mock("../../native/createV5StackNavigator.ios", () => ({
  V5CardStackView: () => null,
  V5StackView: () => null,
  modalEnvelopeOptions: (value: unknown) => value,
}));
vi.mock("./WorkspaceEmptyDetail", () => ({ WorkspaceEmptyDetail: () => null }));

import { createWorkspaceStackNavigator } from "./createWorkspaceStackNavigator.ios";

function RetainedContent() {
  useEffect(() => {
    state.mounts++;
    return () => {
      state.unmounts++;
    };
  }, []);
  return <input aria-label="Draft" defaultValue="retained draft" />;
}

it("bridges the thread removal guard without remounting its retained draft", () => {
  state.blocked = true;
  state.mounts = 0;
  state.unmounts = 0;
  state.goBack.mockReset();
  state.guards.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const Navigator = createWorkspaceStackNavigator().Navigator;
  using _mounted = {
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
  act(() => root.render(<Navigator>{null}</Navigator>));
  const blocked = state.guards.get("thread");
  assert.isTrue(blocked?.preventNativeDismiss);
  act(() => blocked?.onNativeDismissPrevented?.());
  assert.strictEqual(state.goBack.mock.calls.length, 1);
  state.blocked = false;
  act(() => root.render(<Navigator>{null}</Navigator>));
  const released = state.guards.get("thread");
  assert.isFalse(released?.preventNativeDismiss);
  act(() => released?.onNativeDismissPrevented?.());
  assert.strictEqual(state.goBack.mock.calls.length, 1);
  assert.strictEqual(state.mounts, 1);
  assert.strictEqual(state.unmounts, 0);
});
