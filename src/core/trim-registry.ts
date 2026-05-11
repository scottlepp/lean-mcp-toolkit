// Named projection registry — type-safe scaffolding.
//
// Operations in the manifest declare projections by string key
// (`trim: "issue"`) rather than holding function references directly.
// This lets the CLI/code-api layer emit stubs with trim hints without
// serializing closures, and lets dispatchers look up the projection
// at call time without tight coupling.
//
// Servers populate their own registry using `createTrimRegistry`,
// which is purely a type-safety helper — it returns the input map
// unchanged but preserves the literal key type so consumers can use
// `keyof typeof registry` as a discriminated string type.
//
// Example:
//   const trimRegistry = createTrimRegistry({
//     issue: issueSummary,
//     search: searchSummary,
//   });
//   type TrimKey = keyof typeof trimRegistry;  // "issue" | "search"

// Each projection takes the raw response and returns a compact
// summary. Typed as `unknown → unknown` at the registry boundary so
// the map can hold heterogeneous signatures; callers that know the
// shape can narrow themselves.
export type TrimFn = (input: unknown) => unknown;

export type TrimRegistry = Record<string, TrimFn>;

// Helper that preserves the literal key type of the input. Pure
// identity at runtime. Use this when constructing a server's
// trim registry so `keyof typeof registry` gives back the actual
// string union rather than `string`.
export function createTrimRegistry<R extends TrimRegistry>(map: R): R {
  return map;
}

// Convenience type alias for narrowing a registry's key type.
export type TrimKeyOf<R extends TrimRegistry> = keyof R & string;
