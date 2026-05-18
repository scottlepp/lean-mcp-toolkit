# Trim — shaping responses for the model

Trim functions are the toolkit's single biggest token-saving lever. They project a raw API response into a compact summary; the full response goes to the sandbox and surfaces only as a `ref` the model can follow.

## The contract

```ts
type TrimFn = (raw: unknown) => unknown;
```

That's it. Pure function, no side effects, no async. Receives the raw response from `client[verb]`; returns the compact projection.

## Allowlist, never denylist

```ts
import { pick } from "@scottlepper/mcp-toolkit/trim";

const issueSummary = (raw: unknown) => {
  const r = raw as { key: string; fields: Record<string, unknown> };
  return {
    key: r.key,
    ...pick(r.fields, ["summary", "status", "assignee"]),
  };
};
```

Why allowlist:
- New API fields default to dropped (safe behavior).
- The contract between server and model stays stable when the API adds noise.
- Reviewers see exactly what the model gets.

## Registering trims

```ts
import { createTrimRegistry } from "@scottlepper/mcp-toolkit/trim-registry";

export const trimRegistry = createTrimRegistry({
  issue: issueSummary,
  page: pageSummary,
  pullrequest: prSummary,
  // The string key here matches `op.trim` on the manifest entry.
});
```

The registry is type-safe (string keys → known set), and the dispatcher throws if a manifest entry references a key that isn't registered.

## Helpers in `@scottlepper/mcp-toolkit/trim`

- **`pick(obj, keys)`** — shallow copy of allowed keys. The workhorse.
- **`paginatedListSummary(raw, { total, startAt, maxResults })`** — for `{ total, startAt, maxResults, values }`-shaped responses (Jira, Confluence, Bitbucket). Drops `values` from the model's view but the ref still has them.
- **`bareListSummary(items, opts)`** — for endpoints that return a bare array with no envelope.
- **`extractNextCursor(raw)`** — pulls a `next` cursor / `_links.next` link out of API pagination metadata.
- **`safeHref(s)`** — strips `javascript:` and other unsafe schemes when piping HTML/ADF through to markdown.
- **`isPlainObject(v)`** — narrow type guard for the trim function input.

## The `{ summary, ref }` envelope

`invokeOperation` does:
1. raw response → trim → `summary`
2. raw response → `sandbox.put(raw)` → `ref` (`refs:abc123…`)
3. returns `{ summary, ref }`.

The model sees `summary` inline. If it needs full detail (PR diff, page body, full issue), it reads the ref. Two cache primitives:

- **`@scottlepper/mcp-toolkit/sandbox`** — content-addressed (SHA256). Anonymous large payloads. Session-isolated; TTL cleanup.
- **`@scottlepper/mcp-toolkit/page-cache`** — versioned-id (`kind + id + version`). Known keys where the version invalidates the cache (PR diff by head SHA, Confluence page by version number).

Use sandbox by default. Use page-cache only when you have a stable `(kind, id, version)` tuple and want re-fetch elision.

## Patterns

### List endpoint → drop inline items, keep counts

```ts
import { paginatedListSummary } from "@scottlepper/mcp-toolkit/trim";

const issueListSummary = (raw: unknown) =>
  paginatedListSummary(raw as any, { itemPreview: false });
// → { total: 42, startAt: 0, maxResults: 50, truncated: true }
```

The model now sees "42 results" and follows the ref for any it cares about. 50× context savings on typical paged endpoints.

### Single-entity get → keep status fields only

```ts
const issueSummary = (raw: unknown) => {
  const r = raw as Record<string, any>;
  return {
    key: r.key,
    url: safeHref(r.self),
    ...pick(r.fields, ["summary", "status", "priority", "assignee"]),
  };
};
```

### Mutation → minimal acknowledgement

For POST/PUT/DELETE, use the mutation-ack helper:

```ts
import { createMutationAck } from "@scottlepper/mcp-toolkit/mutation-ack";

const created = createMutationAck({ kind: "issue", id: r.key, url: r.self });
// → { ok: true, kind: "issue", id: "PROJ-123", url: "..." }
```

Pairs with the dispatcher's rule: `full: true` is rejected on non-GET ops because mutation-ack already carries everything useful.

## Don't

- **Don't fetch inside a trim.** Sync, pure, no I/O.
- **Don't drop fields the agent needs to chain.** If the next operation needs `r.id`, the summary must include it.
- **Don't return huge text bodies.** ADF, page body, PR descriptions — leave them in the ref, surface a length or summary instead.
- **Don't forget the trim key.** `op.trim = "foo"` requires `createTrimRegistry({ foo: ... })`.
