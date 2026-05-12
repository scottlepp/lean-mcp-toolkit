import { describe, expect, it } from "vitest";

import { createMutationAck } from "./mutation-ack.js";

describe("createMutationAck", () => {
  it("returns { ok: true } for empty / null / non-object input", () => {
    const ack = createMutationAck();
    expect(ack({})).toEqual({ ok: true });
    expect(ack(null)).toEqual({ ok: true });
    expect(ack(undefined)).toEqual({ ok: true });
    expect(ack("plain string")).toEqual({ ok: true });
    expect(ack(42)).toEqual({ ok: true });
  });

  it("picks default fields (id, state, title) when present", () => {
    const ack = createMutationAck();
    expect(
      ack({ id: 7, state: "OPEN", title: "hi", extra: "drop me" }),
    ).toEqual({ ok: true, id: 7, state: "OPEN", title: "hi" });
  });

  it("ignores non-primitive picks", () => {
    const ack = createMutationAck();
    expect(ack({ id: { wrapped: 7 } })).toEqual({ ok: true });
  });

  it("supports custom pick list", () => {
    const ack = createMutationAck({ pick: ["id", "approved"] });
    expect(ack({ id: 1, approved: true, state: "OPEN" })).toEqual({
      ok: true,
      id: 1,
      approved: true,
    });
  });

  it("lifts nested paths via liftPaths", () => {
    const ack = createMutationAck({
      pick: ["id"],
      liftPaths: { merge_commit: "merge_commit.hash" },
    });
    expect(
      ack({ id: 7, merge_commit: { hash: "abc123def" } }),
    ).toEqual({ ok: true, id: 7, merge_commit: "abc123def" });
  });

  it("skips lift paths whose resolution is undefined / non-primitive", () => {
    const ack = createMutationAck({
      liftPaths: { merge_commit: "merge_commit.hash" },
    });
    expect(ack({ merge_commit: null })).toEqual({ ok: true });
    expect(ack({ merge_commit: { hash: { nested: 1 } } })).toEqual({ ok: true });
    expect(ack({})).toEqual({ ok: true });
  });

  it("matches the bitbucket mutationAck shape (pick + liftPaths combined)", () => {
    const ack = createMutationAck({
      pick: ["id", "state", "title", "approved"],
      liftPaths: { merge_commit: "merge_commit.hash" },
    });
    expect(
      ack({
        id: 39636,
        state: "MERGED",
        title: "feat: thing",
        approved: true,
        merge_commit: { hash: "deadbeef" },
        // Noise we should drop:
        rendered: { description: { raw: "long body" } },
        participants: [{ user: { display_name: "X" } }],
      }),
    ).toEqual({
      ok: true,
      id: 39636,
      state: "MERGED",
      title: "feat: thing",
      approved: true,
      merge_commit: "deadbeef",
    });
  });
});
