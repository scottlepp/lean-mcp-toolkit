import { describe, expect, it } from "vitest";

import {
  parseToolFilterEnv,
  parseToolMode,
  splitCsv,
} from "./index.js";

describe("splitCsv", () => {
  it("handles undefined and empty", () => {
    expect(splitCsv(undefined)).toEqual([]);
    expect(splitCsv("")).toEqual([]);
  });
  it("trims whitespace and drops empty entries", () => {
    expect(splitCsv("a, b , ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("parseToolFilterEnv", () => {
  const captureStderr = () => {
    const buf: string[] = [];
    return {
      stderr: { write: (s: string) => buf.push(s) },
      output: buf,
    };
  };

  it("returns empty arrays when env vars are unset", () => {
    const { stderr } = captureStderr();
    const r = parseToolFilterEnv({
      enabledCategoriesEnv: undefined,
      disabledActionsEnv: undefined,
      validCategories: ["a", "b"],
      stderr,
    });
    expect(r).toEqual({ enabledCategories: [], disabledActions: [] });
  });

  it("keeps known categories, drops unknown with warning", () => {
    const { stderr, output } = captureStderr();
    const r = parseToolFilterEnv({
      enabledCategoriesEnv: "a,bogus,b",
      disabledActionsEnv: "thing.delete",
      validCategories: ["a", "b", "c"],
      envVarName: "TEST_ENABLED_CATEGORIES",
      stderr,
    });
    expect(r.enabledCategories).toEqual(["a", "b"]);
    expect(r.disabledActions).toEqual(["thing.delete"]);
    expect(output.join("")).toMatch(/Unknown category "bogus"/);
    expect(output.join("")).toMatch(/TEST_ENABLED_CATEGORIES/);
  });

  it("doesn't validate disabledActions (manifest does)", () => {
    const { stderr } = captureStderr();
    const r = parseToolFilterEnv({
      enabledCategoriesEnv: "",
      disabledActionsEnv: "anything.goes,here",
      validCategories: [],
      stderr,
    });
    expect(r.disabledActions).toEqual(["anything.goes", "here"]);
  });
});

describe("parseToolMode", () => {
  it("defaults to classic when unset", () => {
    expect(parseToolMode(undefined)).toBe("classic");
    expect(parseToolMode("")).toBe("classic");
  });
  it("accepts custom default", () => {
    expect(parseToolMode(undefined, { default: "code-api" })).toBe("code-api");
  });
  it("accepts classic / code-api", () => {
    expect(parseToolMode("classic")).toBe("classic");
    expect(parseToolMode("code-api")).toBe("code-api");
  });
  it("throws on invalid input", () => {
    expect(() => parseToolMode("bogus")).toThrow(/Invalid/);
  });
  it("includes env var name in error", () => {
    expect(() =>
      parseToolMode("bogus", { envVarName: "BITBUCKET_TOOL_MODE" }),
    ).toThrow(/BITBUCKET_TOOL_MODE/);
  });
});
