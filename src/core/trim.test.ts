import { describe, expect, it } from "vitest";
import {
  bareListSummary,
  extractNextCursor,
  isPlainObject,
  paginatedListSummary,
  pick,
  safeHref,
} from "./trim.js";

describe("pick", () => {
  it("returns a new object with only the requested keys", () => {
    const src = { a: 1, b: 2, c: 3 };
    expect(pick(src, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("skips keys not present on the source", () => {
    const src = { a: 1 } as { a: number; b?: number };
    expect(pick(src, ["a", "b"])).toEqual({ a: 1 });
  });

  it("aliases nested values (shallow copy)", () => {
    const nested = { x: 1 };
    const src = { a: nested, b: 2 };
    const out = pick(src, ["a"]);
    expect(out.a).toBe(nested);
  });
});

describe("isPlainObject", () => {
  it("returns true for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });
  it("returns false for arrays, null, primitives", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("paginatedListSummary", () => {
  it("surfaces total/startAt/maxResults verbatim when present", () => {
    expect(
      paginatedListSummary({
        total: 100,
        startAt: 25,
        maxResults: 50,
        values: [1, 2, 3],
      }),
    ).toEqual({ total: 100, startAt: 25, maxResults: 50, truncated: true });
  });

  it("falls back to itemCount when total/maxResults missing", () => {
    expect(
      paginatedListSummary({ values: [1, 2, 3] }),
    ).toEqual({ total: 3, startAt: 0, maxResults: 3, truncated: true });
  });

  it("handles empty list", () => {
    expect(paginatedListSummary({ values: [] })).toEqual({
      total: 0,
      startAt: 0,
      maxResults: 0,
      truncated: false,
    });
  });

  it("returns zeros for non-object inputs", () => {
    expect(paginatedListSummary(null)).toEqual({
      total: 0,
      startAt: 0,
      maxResults: 0,
      truncated: false,
    });
    expect(paginatedListSummary([])).toEqual({
      total: 0,
      startAt: 0,
      maxResults: 0,
      truncated: false,
    });
  });

  it("probes alternate item keys (comments, issues, results, ...)", () => {
    expect(paginatedListSummary({ comments: [1] }).truncated).toBe(true);
    expect(paginatedListSummary({ results: [1, 2] }).total).toBe(2);
    expect(paginatedListSummary({ issues: [1, 2, 3] }).total).toBe(3);
  });

  it("accepts custom itemsKeys", () => {
    expect(
      paginatedListSummary({ exoticItems: [1, 2] }, { itemsKeys: ["exoticItems"] }),
    ).toEqual({ total: 2, startAt: 0, maxResults: 2, truncated: true });
  });
});

describe("bareListSummary", () => {
  it("returns count for arrays", () => {
    expect(bareListSummary([1, 2, 3])).toEqual({ count: 3, truncated: true });
  });
  it("returns count 0 for non-arrays", () => {
    expect(bareListSummary(null)).toEqual({ count: 0, truncated: false });
    expect(bareListSummary({})).toEqual({ count: 0, truncated: false });
  });
});

describe("extractNextCursor", () => {
  it("extracts cursor from absolute URL", () => {
    expect(
      extractNextCursor("https://api.example.com/things?cursor=ABC123&limit=25"),
    ).toBe("ABC123");
  });

  it("extracts cursor from relative URL", () => {
    expect(extractNextCursor("/api/things?cursor=XYZ")).toBe("XYZ");
  });

  it("returns undefined when cursor param is absent", () => {
    expect(extractNextCursor("https://api.example.com/things?limit=25")).toBeUndefined();
  });

  it("returns undefined for non-string inputs", () => {
    expect(extractNextCursor(undefined)).toBeUndefined();
    expect(extractNextCursor(null)).toBeUndefined();
    expect(extractNextCursor(42)).toBeUndefined();
    expect(extractNextCursor("")).toBeUndefined();
  });

  it("accepts custom paramName", () => {
    expect(
      extractNextCursor("/x?nextPageToken=ABC", { paramName: "nextPageToken" }),
    ).toBe("ABC");
  });
});

describe("safeHref", () => {
  it("allows http(s), mailto, ftp, root-relative, fragments", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:user@example.com")).toBe("mailto:user@example.com");
    expect(safeHref("ftp://server")).toBe("ftp://server");
    expect(safeHref("/relative/path")).toBe("/relative/path");
    expect(safeHref("#fragment")).toBe("#fragment");
  });

  it("rejects javascript, data, file, vbscript, protocol-relative", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("vbscript:foo")).toBeNull();
    expect(safeHref("//host.com/path")).toBeNull();
  });

  it("trims whitespace before testing", () => {
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
  });

  it("returns null for non-strings or empty", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });
});
