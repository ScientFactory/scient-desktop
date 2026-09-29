import { describe, expect, it } from "vite-plus/test";
import { conversationFilePathsFromArgv } from "./conversationFileArguments.ts";

describe("conversation file launch arguments", () => {
  it("resolves local paths, Unicode and encoded file URLs without shell interpretation", () => {
    expect(
      conversationFilePathsFromArgv(
        [
          "scient",
          "one.SCIC",
          "file:///tmp/%D7%A9%D7%9C%D7%95%D7%9D%20%23.scic",
          "./one.SCIC",
          "$(touch bad).scic",
        ],
        "/tmp",
        "linux",
      ),
    ).toEqual(["/tmp/one.SCIC", "/tmp/שלום #.scic", "/tmp/$(touch bad).scic"]);
  });
  it("uses Windows semantics even in cross-platform tests", () => {
    expect(
      conversationFilePathsFromArgv(
        ["scient.exe", "a b.scic", "file:///C:/docs/test.scic"],
        "C:\\docs",
        "win32",
      ),
    ).toEqual(["C:\\docs\\a b.scic", "C:\\docs\\test.scic"]);
  });
  it("does not turn protocols, flags, malformed URLs or network shares into files", () => {
    expect(
      conversationFilePathsFromArgv(
        [
          "scient",
          "https://host/a.scic",
          "scient://a.scic",
          "file://remote/a.scic",
          "file:///tmp/%ZZ.scic",
          "file:///tmp/a.scic?x=.scic",
          "--target=a.scic",
          "\\\\host\\a.scic",
          "//host/a.scic",
          "bad\0.scic",
        ],
        "/tmp",
        "linux",
      ),
    ).toEqual([]);
  });
});
