import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { skipMirroredTextareaDefaults } from "./textareaDefaultValue";

function Draft() {
  const [value, setValue] = useState("");
  return (
    <textarea
      aria-label="Draft"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
    />
  );
}

it("keeps a controlled textarea's text node while typing", async () => {
  using _defaults = { [Symbol.dispose]: skipMirroredTextareaDefaults() };
  await using screen = await render(<Draft />);
  const textarea = screen.container.querySelector("textarea")!;
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(textarea, { childList: true, characterData: true, subtree: true });
  using _observer = { [Symbol.dispose]: () => observer.disconnect() };

  await userEvent.type(textarea, "variance");

  expect(textarea.value).toBe("variance");
  expect([...mutations, ...observer.takeRecords()]).toEqual([]);
});

it("still applies a default that differs from the shown text", () => {
  using _defaults = { [Symbol.dispose]: skipMirroredTextareaDefaults() };
  const textarea = document.createElement("textarea");

  textarea.defaultValue = "Initial draft";

  expect(textarea.value).toBe("Initial draft");
  expect(textarea.textContent).toBe("Initial draft");
});
