import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { installMirroredDefaultSkip, SKIP_MIRRORED_DEFAULT } from "./textareaDefaultValue";

function Draft({ marked }: { marked: boolean }) {
  const [value, setValue] = useState("");
  return (
    <textarea
      {...(marked ? SKIP_MIRRORED_DEFAULT : {})}
      aria-label="Draft"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
    />
  );
}

async function typeDraft(marked: boolean) {
  using _skip = { [Symbol.dispose]: installMirroredDefaultSkip(document) };
  await using screen = await render(<Draft marked={marked} />);
  const textarea = screen.container.querySelector("textarea")!;
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(textarea, { childList: true, characterData: true, subtree: true });
  using _observer = { [Symbol.dispose]: () => observer.disconnect() };

  await userEvent.type(textarea, "variance");

  return {
    value: textarea.value,
    defaultValue: textarea.defaultValue,
    mutations: [...mutations, ...observer.takeRecords()].length,
  };
}

it("keeps a marked textarea's text node while typing", async () => {
  const typed = await typeDraft(true);

  expect(typed.value).toBe("variance");
  expect(typed.mutations).toBe(0);
});

it("leaves an unmarked textarea's default in step with its value", async () => {
  const typed = await typeDraft(false);

  expect(typed.value).toBe("variance");
  expect(typed.defaultValue).toBe("variance");
});
