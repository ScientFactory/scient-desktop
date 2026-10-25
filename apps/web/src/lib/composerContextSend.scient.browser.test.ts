import { EnvironmentId } from "@t3tools/contracts";

import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

type Config = { environment: { capabilities: { inlineMessageContext?: boolean } } };
const state = vi.hoisted(() => ({
  configs: undefined as Atom.Writable<Map<EnvironmentId, Config>> | undefined,
}));
vi.mock("../state/server", async (original) => {
  const actual = await original<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  state.configs = Atom.make(new Map<EnvironmentId, Config>());
  return { ...actual, environmentServerConfigsAtom: state.configs };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { prepareComposerContextMessage } from "./composerContextSend";

const environmentId = EnvironmentId.make("synthetic-send");

function setup() {
  const configs = state.configs!;
  const unmount = appAtomRegistry.mount(configs);
  const previous = appAtomRegistry.get(configs);
  appAtomRegistry.set(configs, new Map());
  return {
    capability(id: EnvironmentId, value: boolean | undefined) {
      appAtomRegistry.update(configs, (current) =>
        new Map(current).set(id, {
          environment: { capabilities: value === undefined ? {} : { inlineMessageContext: value } },
        }),
      );
    },
    [Symbol.dispose]() {
      appAtomRegistry.set(configs, previous);
      unmount();
    },
  };
}

describe("composer submission capability boundary", () => {
  // regression: c66c948db0 chore(upstream): merge t3 through 81dea7821d
  it.each([true, false, undefined])(
    "leaves a context-free message untouched with capability %s",
    (value) => {
      using scope = setup();
      scope.capability(environmentId, value);
      expect(
        prepareComposerContextMessage({ environmentId, text: "plain prose  ", context: undefined }),
      ).toEqual({ text: "plain prose  " });
    },
  );
});
