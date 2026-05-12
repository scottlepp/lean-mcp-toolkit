import { describe, expect, it } from "vitest";

import { TtlLruCache } from "./lru.js";

describe("TtlLruCache", () => {
  it("rejects bad options", () => {
    expect(() => new TtlLruCache({ maxSize: 0, ttlMs: 1000 })).toThrow();
    expect(() => new TtlLruCache({ maxSize: 1, ttlMs: -1 })).toThrow();
  });

  it("round-trips a value within TTL", () => {
    let t = 0;
    const cache = new TtlLruCache<string, number>({
      maxSize: 2,
      ttlMs: 100,
      now: () => t,
    });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    t = 99;
    expect(cache.get("a")).toBe(1);
  });

  it("expires entries past their TTL on read", () => {
    let t = 0;
    const cache = new TtlLruCache<string, number>({
      maxSize: 4,
      ttlMs: 100,
      now: () => t,
    });
    cache.set("a", 1);
    t = 101;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts least-recently-used when over capacity", () => {
    const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("touch-on-read promotes recency", () => {
    const cache = new TtlLruCache<string, number>({ maxSize: 2, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    // Read "a" — now "b" is the LRU.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3); // evicts "b"
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("set on an existing key refreshes its expiry and recency", () => {
    let t = 0;
    const cache = new TtlLruCache<string, number>({
      maxSize: 2,
      ttlMs: 100,
      now: () => t,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    t = 50;
    cache.set("a", 10); // refresh
    t = 120; // past original a expiry, before refreshed one
    expect(cache.get("a")).toBe(10);
    // "b" expired at t=100 even though never overflowed; reads it as miss.
    expect(cache.get("b")).toBeUndefined();
  });

  it("delete and clear behave as expected", () => {
    const cache = new TtlLruCache<string, number>({ maxSize: 4, ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("size reflects current entry count", () => {
    const cache = new TtlLruCache<string, number>({ maxSize: 5, ttlMs: 10_000 });
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });
});
