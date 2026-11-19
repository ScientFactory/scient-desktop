import { expect, it } from "vite-plus/test";

import { accountsOwner } from "./accountsOwner.ts";

const window = (id: number) => ({ id, webContents: { id: id * 10 } });

it("gives the background work to the oldest open window, and to the next when it closes", () => {
  // App windows are kept most recently focused first; focus never moves the role.
  expect(accountsOwner([window(3), window(1), window(2)])).toBe(10);
  expect(accountsOwner([window(3), window(2)])).toBe(20);
  expect(accountsOwner([])).toBeUndefined();
});
