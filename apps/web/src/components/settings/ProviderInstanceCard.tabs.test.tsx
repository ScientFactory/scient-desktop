import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";

const environmentId = EnvironmentId.make("local");

function renderEditor(driver: string, hasShippedDriver: boolean): string {
  const driverKind = ProviderDriverKind.make(driver);
  const instance: ProviderInstanceConfig = {
    driver: driverKind,
    enabled: true,
  };

  return renderToStaticMarkup(
    <ProviderInstanceCard
      environmentId={environmentId}
      instanceId={ProviderInstanceId.make(driver)}
      instance={instance}
      driverOption={hasShippedDriver ? getDriverOption(driverKind) : undefined}
      liveProvider={undefined}
      mode="editor"
      onUpdate={vi.fn()}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={vi.fn()}
      onFavoriteModelsChange={vi.fn()}
      onModelOrderChange={vi.fn()}
    />,
  );
}

describe("ProviderInstanceCard tabs", () => {
  it("opens shipped providers on Models by default", () => {
    const markup = renderEditor("claudeAgent", true);

    expect(markup).toMatch(/aria-pressed="true"[^>]*>Models/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>Configuration<\/button>/);
  });

  it("keeps unknown providers on their available Configuration tab", () => {
    const markup = renderEditor("custom-provider", false);

    expect(markup).not.toContain(">Models");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Configuration<\/button>/);
  });
});
