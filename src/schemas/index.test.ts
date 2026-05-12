import { describe, expect, it } from "vitest";

import { nonNegativeInt, positiveInt } from "./index.js";

describe("positiveInt", () => {
  it("accepts a positive number", () => {
    expect(positiveInt.parse(42)).toBe(42);
  });

  it("accepts a numeric string", () => {
    expect(positiveInt.parse("42")).toBe(42);
  });

  it("rejects zero", () => {
    expect(positiveInt.safeParse(0).success).toBe(false);
  });

  it("rejects negative numbers", () => {
    expect(positiveInt.safeParse(-1).success).toBe(false);
  });

  it("rejects non-numeric strings", () => {
    expect(positiveInt.safeParse("abc").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(positiveInt.safeParse("").success).toBe(false);
  });

  it("rejects undefined with a clear message (not `received NaN`)", () => {
    const r = positiveInt.safeParse(undefined);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = JSON.stringify(r.error.issues);
      expect(msg).not.toMatch(/NaN/);
    }
  });

  it("rejects floats", () => {
    expect(positiveInt.safeParse(1.5).success).toBe(false);
  });
});

describe("nonNegativeInt", () => {
  it("accepts zero", () => {
    expect(nonNegativeInt.parse(0)).toBe(0);
  });

  it("accepts a positive number", () => {
    expect(nonNegativeInt.parse(5)).toBe(5);
  });

  it("accepts the string '0'", () => {
    expect(nonNegativeInt.parse("0")).toBe(0);
  });

  it("rejects negative numbers", () => {
    expect(nonNegativeInt.safeParse(-1).success).toBe(false);
  });
});
