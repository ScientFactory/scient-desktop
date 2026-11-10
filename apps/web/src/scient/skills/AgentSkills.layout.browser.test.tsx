import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "../../index.css";

vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("./scientSkillsState", () => ({
  setProviderSkillEnabled: null,
  providerSkillDocument: vi.fn(),
}));
vi.mock("./SkillCard", () => ({ SkillCard: () => null }));
vi.mock("../../components/chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../components/chat/providerIconUtils", () => ({ AVAILABLE_PROVIDER_OPTIONS: [] }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../components/settings/settingsLayout", () => ({ SettingsRow: () => null }));

import { AgentSkills } from "./AgentSkills";

it("keeps agent provider scrolling inside a narrow skills page", async () => {
  await using stack = new AsyncDisposableStack();
  const host = document.createElement("div");
  host.style.cssText = "width: 402px; overflow: auto;";
  document.body.append(host);
  stack.defer(() => host.remove());
  const providers: ServerProvider[] = Array.from({ length: 24 }, (_, index) => ({
    instanceId: ProviderInstanceId.make(`agent-${index}`),
    driver: ProviderDriverKind.make("codex"),
    displayName: `Research agent ${index}`,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [{ name: "review", path: "/skills/review/SKILL.md", scope: "user", enabled: true }],
  }));
  stack.use(
    await render(
      <div className="grid gap-10">
        <section className="grid gap-3">
          <AgentSkills environmentId={EnvironmentId.make("local")} providers={providers} />
        </section>
      </div>,
      // This layout fixture contains no navigation.
      { container: host, router: false },
    ),
  );
  const strip = host.querySelector<HTMLElement>('[aria-label="Agent providers"]')!;
  await vi.waitFor(() => {
    expect(host.scrollWidth).toBe(host.clientWidth);
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
  });
  strip.scrollLeft = 200;
  expect(strip.scrollLeft).toBeGreaterThan(0);
  expect(host.scrollLeft).toBe(0);
});
