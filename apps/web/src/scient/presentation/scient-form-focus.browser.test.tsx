import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { Button } from "~/components/ui/button";
import { Combobox, ComboboxInput } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { Select, SelectTrigger } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

it.each(["light", "dark"])("keeps one form focus border in %s mode", async (mode) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.host = document.createElement("div");
  _fixture.host.className = mode;
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <>
      <Input aria-label="Plain input" />
      <InputGroup variant="ghost">
        <InputGroupInput aria-label="Browser address" placeholder="Search or enter URL" />
      </InputGroup>
      <Textarea aria-label="Text area" />
      <NumberField defaultValue={1}>
        <NumberFieldGroup>
          <NumberFieldInput aria-label="Number" />
        </NumberFieldGroup>
      </NumberField>
      <Select>
        <SelectTrigger aria-label="Bordered select">Select</SelectTrigger>
      </Select>
      <Combobox>
        <ComboboxInput aria-label="Combobox" showTrigger={false} />
      </Combobox>
      <Select>
        <SelectTrigger variant="ghost" aria-label="Ghost select">
          Ghost
        </SelectTrigger>
      </Select>
      <Button variant="ghost">Unrelated button</Button>
    </>,
  );
  await expect.poll(() => _fixture.host?.querySelector('[data-slot="button"]')).toBeTruthy();
  await userEvent.tab();

  for (const name of [
    "Plain input",
    "Browser address",
    "Text area",
    "Number",
    "Bordered select",
    "Combobox",
  ]) {
    const field = _fixture.host.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
    const surface =
      field.closest<HTMLElement>('[data-slot="input-group"]') ??
      field.closest<HTMLElement>(
        '[data-slot="input-control"], [data-slot="textarea-control"], [data-slot="number-field-group"], [data-slot="select-trigger"]',
      )!;
    let validBorder = "";
    for (const invalid of [false, true]) {
      field.blur();
      if (invalid) field.setAttribute("aria-invalid", "true");
      else field.removeAttribute("aria-invalid");
      const restingBorder = getComputedStyle(surface).borderColor;
      field.focus();
      expect(field.matches(":focus-visible")).toBe(true);
      await expect.poll(() => getComputedStyle(surface).boxShadow).toBe("none");
      await expect.poll(() => getComputedStyle(surface).borderColor).not.toBe(restingBorder);
      const focused = getComputedStyle(surface);
      expect(focused.borderTopWidth).toBe("1px");
      expect(focused.borderTopStyle).toBe("solid");
      expect(focused.borderColor).not.toBe("rgba(0, 0, 0, 0)");
      if (invalid) expect(focused.borderColor).not.toBe(validBorder);
      else validBorder = focused.borderColor;
    }
  }

  for (const field of [
    _fixture.host.querySelector<HTMLElement>('[aria-label="Ghost select"]')!,
    _fixture.host.querySelector<HTMLElement>('[data-slot="button"]')!,
  ]) {
    field.focus();
    expect(field.matches(":focus-visible")).toBe(true);
    await expect.poll(() => getComputedStyle(field).boxShadow).not.toBe("none");
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
