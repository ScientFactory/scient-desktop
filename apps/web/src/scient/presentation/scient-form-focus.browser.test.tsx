import "../../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { Button } from "~/components/ui/button";
import { Combobox, ComboboxInput } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { Select, SelectTrigger } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

it.each(["light", "dark"])("keeps one form focus border in %s mode", async (mode) => {
  host = document.createElement("div");
  host.className = mode;
  document.body.append(host);
  root = createRoot(host);
  root.render(
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
  await expect.poll(() => host?.querySelector('[data-slot="button"]')).toBeTruthy();
  await userEvent.tab();

  for (const name of [
    "Plain input",
    "Browser address",
    "Text area",
    "Number",
    "Bordered select",
    "Combobox",
  ]) {
    const field = host.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
    const surface =
      field.closest<HTMLElement>('[data-slot="input-group"]') ??
      field.closest<HTMLElement>(
        '[data-slot="input-control"], [data-slot="textarea-control"], [data-slot="number-field-group"], [data-slot="select-trigger"]',
      )!;
    let validBorder = "";
    for (const invalid of [false, true]) {
      field.blur();
      field.setAttribute("aria-invalid", String(invalid));
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
    host.querySelector<HTMLElement>('[aria-label="Ghost select"]')!,
    host.querySelector<HTMLElement>('[data-slot="button"]')!,
  ]) {
    field.focus();
    expect(field.matches(":focus-visible")).toBe(true);
    await expect.poll(() => getComputedStyle(field).boxShadow).not.toBe("none");
  }
});
