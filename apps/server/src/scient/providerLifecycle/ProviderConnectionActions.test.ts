import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  findTerminalAuthorizationUrl,
  normalizeTerminalOutput,
  pickProcessEnvironment,
  ProviderConnectionActionError,
  withProviderSessionShutdown,
} from "./ProviderConnectionActions.ts";

const acceptsExampleLogin = (url: URL) =>
  url.hostname === "login.example.test" && url.pathname.startsWith("/authorize");

describe("ProviderConnectionActions primitives", () => {
  it("extracts accepted URLs from plain and OSC 8 terminal output", () => {
    expect(
      findTerminalAuthorizationUrl(
        "Open https://login.example.test/authorize?state=scient.",
        acceptsExampleLogin,
      ),
    ).toBe("https://login.example.test/authorize?state=scient");
    expect(
      findTerminalAuthorizationUrl(
        "\u001b]8;;https://login.example.test/authorize?state=metadata\u0007Sign in\u001b]8;;\u0007",
        acceptsExampleLogin,
      ),
    ).toBe("https://login.example.test/authorize?state=metadata");
    expect(
      findTerminalAuthorizationUrl(
        "\u001b]8;;https://login.example.test/authorize?state=st\u001b\\Sign in\u001b]8;;\u001b\\",
        acceptsExampleLogin,
      ),
    ).toBe("https://login.example.test/authorize?state=st");
    expect(
      findTerminalAuthorizationUrl(
        "\u001b[34mhttps://login.example.test/authorize?state=colored\u001b[0m",
        acceptsExampleLogin,
      ),
    ).toBe("https://login.example.test/authorize?state=colored");
  });

  it("strips presentation controls without discarding OSC 8 targets", () => {
    expect(
      normalizeTerminalOutput(
        "\u001b[34mOpen \u001b]8;;https://login.example.test/authorize\u0007browser\u001b]8;;\u0007\u001b[0m",
      ),
    ).toContain("https://login.example.test/authorize");
  });

  it("rejects untrusted, malformed, control-bearing, and oversized candidates", () => {
    expect(
      findTerminalAuthorizationUrl(
        "Open https://other.example.test/authorize then https://login.example.test/authorize",
        acceptsExampleLogin,
      ),
    ).toBe("https://login.example.test/authorize");
    expect(
      findTerminalAuthorizationUrl(
        "Open https://login.example.test/authorize\u0007unexpected",
        acceptsExampleLogin,
      ),
    ).toBeUndefined();
    expect(
      findTerminalAuthorizationUrl("Open https://[invalid/authorize", acceptsExampleLogin),
    ).toBeUndefined();
    expect(
      findTerminalAuthorizationUrl(
        "\u001b]8;;https://login.example.test/authorize",
        acceptsExampleLogin,
      ),
    ).toBeUndefined();
    expect(
      findTerminalAuthorizationUrl(
        "\u001b]0;https://login.example.test/authorize\u0007ordinary title",
        acceptsExampleLogin,
      ),
    ).toBeUndefined();
    expect(
      findTerminalAuthorizationUrl(
        `Open https://login.example.test/authorize?state=${"x".repeat(8_192)}`,
        acceptsExampleLogin,
      ),
    ).toBeUndefined();
    expect(
      findTerminalAuthorizationUrl("Open http://login.example.test/authorize", acceptsExampleLogin),
    ).toBeUndefined();
    expect(
      findTerminalAuthorizationUrl(
        `Open https://login.example.test/authorize ${"x".repeat(128 * 1024)}`,
        acceptsExampleLogin,
      ),
    ).toBeUndefined();
  });

  it("keeps allowed environment values case-insensitively and drops everything else", () => {
    const selected = pickProcessEnvironment(
      {
        HOME: "/Users/scientist",
        Path: "C:\\Windows\\System32",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        TEMP: undefined,
        PROVIDER_SECRET: "must-not-pass",
      },
      ["HOME", "PATH", "COMSPEC", "TEMP"],
    );

    expect(selected).toEqual({
      HOME: "/Users/scientist",
      Path: "C:\\Windows\\System32",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
  });

  it.effect("stops sessions before disconnecting", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const actions = withProviderSessionShutdown(
        {
          methods: [],
          start: () => Effect.die("must not start"),
          disconnect: record("disconnect"),
        },
        record("stop"),
        (cause) => new ProviderConnectionActionError({ message: "stop failed", cause }),
      );

      yield* actions.disconnect;
      expect(yield* Ref.get(events)).toEqual(["stop", "disconnect"]);
    }).pipe(Effect.scoped),
  );

  it.effect("maps shutdown failures and never disconnects while a session may remain active", () =>
    Effect.gen(function* () {
      const disconnects = yield* Ref.make(0);
      const shutdownCause = new Error("session refused to stop");
      const actions = withProviderSessionShutdown(
        {
          methods: [],
          start: () => Effect.die("must not start"),
          disconnect: Ref.update(disconnects, (count) => count + 1),
        },
        Effect.fail(shutdownCause),
        (cause) => new ProviderConnectionActionError({ message: "mapped shutdown failure", cause }),
      );

      const failure = yield* actions.disconnect.pipe(Effect.flip);
      expect(failure.message).toBe("mapped shutdown failure");
      expect(failure.cause).toBe(shutdownCause);
      expect(yield* Ref.get(disconnects)).toBe(0);
    }).pipe(Effect.scoped),
  );
});
