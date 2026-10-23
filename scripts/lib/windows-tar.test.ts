import { afterEach, expect, it, vi } from "vite-plus/test";
import { windowsSystemTar } from "./windows-tar.ts";

afterEach(() => vi.unstubAllEnvs());

it("uses the Windows system tar rather than the Git tar on PATH", () => {
  vi.stubEnv("SystemRoot", "D:\\Windows");
  vi.stubEnv("windir", "E:\\Windows");
  expect(windowsSystemTar()).toBe("D:\\Windows\\System32\\tar.exe");
});

it("falls back to windir and then the conventional system root", () => {
  vi.stubEnv("SystemRoot", undefined);
  vi.stubEnv("windir", "E:\\Windows");
  expect(windowsSystemTar()).toBe("E:\\Windows\\System32\\tar.exe");
  vi.stubEnv("windir", undefined);
  expect(windowsSystemTar()).toBe("C:\\Windows\\System32\\tar.exe");
});
