// Configurable "mutation ack" trim factory.
//
// Most write endpoints across REST APIs return the full mutated
// resource by default — kilobytes (or more) of state the agent rarely
// needs. The classic trim projection for these is a tiny ack: did the
// write succeed, what was the new state, what was its identity.
//
// This factory ships the SDK pattern: pick a configurable set of
// top-level fields plus a configurable set of nested lift-paths
// (e.g. `merge_commit.hash` → `merge_commit`). The result always
// starts `{ ok: true, ... }`. Empty 204 responses (no body) collapse
// to `{ ok: true }`.

import type { TrimFn } from "../core/trim-registry.js";

export interface MutationAckConfig {
  // Top-level fields to lift from the raw response when their value is
  // a primitive (string | number | boolean). Default:
  // `["id", "state", "title"]` — the universal "what was touched / what
  // state did it land in / what's it called" trio.
  pick?: string[];
  // Path expressions for nested fields. E.g.
  //   { merge_commit: "merge_commit.hash" }
  // lifts `response.merge_commit.hash` to `ack.merge_commit`. The
  // value must be a primitive; non-primitive resolutions are dropped.
  // Paths are dot-separated; intermediate values must be plain
  // objects. Missing / undefined resolutions are skipped silently.
  liftPaths?: Record<string, string>;
}

export interface MutationAck {
  ok: true;
  [key: string]: unknown;
}

const DEFAULT_PICK = ["id", "state", "title"];

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Build a trim function that projects a write response into a compact
// ack. Returns `{ ok: true }` for null/non-object/empty inputs.
export function createMutationAck(config: MutationAckConfig = {}): TrimFn {
  const pick = config.pick ?? DEFAULT_PICK;
  const liftPaths = config.liftPaths ?? {};

  return (raw: unknown): MutationAck => {
    if (!isPlainObject(raw)) return { ok: true };
    const out: MutationAck = { ok: true };
    for (const key of pick) {
      const v = raw[key];
      if (isPrimitive(v)) out[key] = v;
    }
    for (const [outKey, path] of Object.entries(liftPaths)) {
      const v = resolvePath(raw, path);
      if (isPrimitive(v)) out[outKey] = v;
    }
    return out;
  };
}
