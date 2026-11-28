import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";
import { TextGeneratorsSettings } from "../../components/settings/TextGeneratorsSettings";

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
  useUpdateEnvironmentSettings: () => () => {},
}));

it("opens the text generator setup with its steps and no explanation", async () => {
  await using _screen = await render(
    <TextGeneratorsSettings
      environmentId={EnvironmentId.make("local")}
      environmentLabel="This device"
      providers={[]}
      readOnly={false}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Add generator" }));
  await expect.element(page.getByRole("heading", { name: "Add a text generator" })).toBeVisible();
  // Run 4: the paragraph about titles and where the key is stored goes; the guide says it.
  expect(page.getByText(/Writes thread titles/).elements()).toHaveLength(0);
});
