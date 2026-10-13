// @effect-diagnostics nodeBuiltinImport:off -- Tests inspect only the qualification's own disposable homes.
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it, vi } from "vite-plus/test";
import type { MuseSdkHost, createMuseSdkHost } from "@t3tools/provider-muse/server";
import { qualifyMuseManagedRuntime } from "./MuseManagedRuntimeQualification.ts";
type HostOptions = Parameters<typeof createMuseSdkHost>[0];

describe("Muse managed MSP qualification", () => {
  it("cleans up failed acquisition only after the SDK proves native shutdown", async () => {
    let home = "";
    const createHost = vi.fn(async (options: HostOptions): Promise<MuseSdkHost> => {
      home = options.cwd!;
      options.onClosed?.();
      throw new Error("Fixture startup failed after native close.");
    });
    await expect(
      qualifyMuseManagedRuntime(
        {
          executablePath: "/fixture/muse",
          environment: {},
          signal: new AbortController().signal,
        },
        createHost,
      ),
    ).rejects.toThrow("startup failed");
    await expect(NodeFSP.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses a credential-free environment and closes native MSP before deleting its home", async () => {
    let home = "";
    let closed = false;
    const request = vi.fn(async () => ({ models: [] }));
    const createHost = vi.fn(async (options: HostOptions) => {
      home = options.cwd!;
      expect(options.readOnly).toBe(true);
      expect(options.environment?.META_API_KEY).toBeUndefined();
      expect(options.environment?.ACCESS_TOKEN).toBeUndefined();
      expect(options.environment?.MUSE_LOGIN).toBe("0");
      expect(options.environment?.HOME).toBe(home);
      expect(options.environment?.USERPROFILE).toBe(home);
      expect(options.environment?.XDG_CONFIG_HOME).toContain(home);
      const host = {
        connection: { request },
        close: async () => {
          expect((await NodeFSP.stat(home)).isDirectory()).toBe(true);
          closed = true;
        },
      };
      return host as unknown as MuseSdkHost;
    });
    await qualifyMuseManagedRuntime(
      {
        executablePath: "/fixture/muse",
        environment: {
          PATH: "/fixture/bin",
          META_API_KEY: "fixture-secret",
          ACCESS_TOKEN: "fixture-token",
        },
        signal: new AbortController().signal,
      },
      createHost,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("model/list", {});
    expect(closed).toBe(true);
    await expect(NodeFSP.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses activation on protocol failure and still closes before cleanup", async () => {
    let home = "";
    const close = vi.fn(async () => {});
    const createHost = vi.fn(async (options: HostOptions) => {
      home = options.cwd!;
      return {
        connection: { request: async () => ({ invalid: true }) },
        close,
      } as unknown as MuseSdkHost;
    });
    await expect(
      qualifyMuseManagedRuntime(
        {
          executablePath: "/fixture/muse",
          environment: {},
          signal: new AbortController().signal,
        },
        createHost,
      ),
    ).rejects.toThrow("invalid model catalog");
    expect(close).toHaveBeenCalledOnce();
    await expect(NodeFSP.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the home when native close cannot be confirmed", async () => {
    let home = "";
    const createHost = vi.fn(async (options: HostOptions) => {
      home = options.cwd!;
      return {
        connection: { request: async () => ({ models: [] }) },
        close: async () => {
          throw new Error("fixture close failure");
        },
      } as unknown as MuseSdkHost;
    });
    try {
      await expect(
        qualifyMuseManagedRuntime(
          {
            executablePath: "/fixture/muse",
            environment: {},
            signal: new AbortController().signal,
          },
          createHost,
        ),
      ).rejects.toThrow("fixture close failure");
      expect((await NodeFSP.stat(home)).isDirectory()).toBe(true);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
