// Generic helpers for response trimming.
//
// Entity-specific projections (issueSummary, pageSummary, prSummary)
// live in each consumer server. This module provides the lower-level
// utilities that those projections call: `pick`, list summarizers,
// cursor extraction from API pagination links, safe-href filtering for
// markup conversion.

// --- pick --------------------------------------------------------------

// Construct a new object from a subset of keys. The opposite of
// "denylist filtering" — we always declare what to keep. Returns a
// shallow copy; nested values are aliased into the result.
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    if (k in obj) {
      out[k] = obj[k];
    }
  }
  return out;
}

// --- type guards -------------------------------------------------------

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

// --- List summaries ----------------------------------------------------

// Common paginated-list shape used across many APIs (Jira PageBean,
// Bitbucket paged response, Confluence results envelope). The
// projection is deliberately count + metadata only — no inline items.
// The full untrimmed body still lands on disk via sandbox(); callers
// who want per-item detail read the ref.
export interface ListSummary {
  total: number;
  startAt: number;
  maxResults: number;
  // True when the inline projection is missing items the ref has.
  // Today this is `itemCount > 0` since we inline nothing. Kept so
  // callers can extend with inline previews later without changing the
  // field set.
  truncated: boolean;
}

// Item-array keys to probe for, in order. Standard across the APIs
// the SDK targets. Servers can override via the `itemsKeys` option.
const DEFAULT_ITEMS_KEYS = [
  "values", // generic
  "results", // Confluence
  "items", // common
  "comments",
  "worklogs",
  "issues",
  "groups",
] as const;

export interface PaginatedListOptions {
  // Override the keys probed for the item array. Pass when the API
  // uses an idiosyncratic field name not in the default list.
  itemsKeys?: readonly string[];
}

export function paginatedListSummary(
  raw: unknown,
  options: PaginatedListOptions = {},
): ListSummary {
  if (!isPlainObject(raw)) {
    return { total: 0, startAt: 0, maxResults: 0, truncated: false };
  }
  const itemsKeys = options.itemsKeys ?? DEFAULT_ITEMS_KEYS;
  let itemCount = 0;
  for (const k of itemsKeys) {
    const v = raw[k];
    if (Array.isArray(v)) {
      itemCount = v.length;
      break;
    }
  }
  const totalRaw = raw.total;
  const startAtRaw = raw.startAt;
  const maxResultsRaw = raw.maxResults;
  return {
    total: typeof totalRaw === "number" ? totalRaw : itemCount,
    startAt: typeof startAtRaw === "number" ? startAtRaw : 0,
    maxResults: typeof maxResultsRaw === "number" ? maxResultsRaw : itemCount,
    truncated: itemCount > 0,
  };
}

// Bare-array list (no pagination envelope). Surfaces a count so the
// caller knows whether to bother reading the ref.
export interface BareListSummary {
  count: number;
  truncated: boolean;
}

export function bareListSummary(
  raw: unknown,
): BareListSummary {
  const count = Array.isArray(raw) ? raw.length : 0;
  return { count, truncated: count > 0 };
}

// --- Cursor extraction -------------------------------------------------

// Many modern REST APIs (Confluence v2, Bitbucket) return pagination
// as `{ _links: { next: "<absolute or relative URL>" } }` or
// `{ next: "<URL>" }`. The cursor parameter inside that URL is what
// callers actually need to pass back; the full URL is noise that ties
// the response shape to the endpoint structure.
//
// Pass either the raw "next" URL string or an object containing it
// under a common key. Returns the cursor value or undefined.
export interface ExtractCursorOptions {
  // Query parameter name that holds the cursor. Defaults to "cursor".
  // Some APIs use "page" or "nextPageToken" — pass the right name.
  paramName?: string;
}

export function extractNextCursor(
  linksNext: unknown,
  options: ExtractCursorOptions = {},
): string | undefined {
  if (typeof linksNext !== "string" || linksNext.length === 0) {
    return undefined;
  }
  const paramName = options.paramName ?? "cursor";
  try {
    // The placeholder base lets us parse both relative and absolute
    // URLs uniformly. URLSearchParams returns null when the key isn't
    // present; we collapse that to undefined.
    const url = new URL(linksNext, "https://placeholder.invalid");
    return url.searchParams.get(paramName) ?? undefined;
  } catch {
    return undefined;
  }
}

// --- Safe-href filtering ----------------------------------------------

// Markup converters (ADF→markdown, HTML→markdown) write user-supplied
// link hrefs into the output. If that markdown is later rendered as
// HTML downstream, dangerous schemes like `javascript:` or `data:`
// become XSS vectors. `safeHref` returns the raw value if it matches
// an allowlist of safe schemes, or `null` if the caller should fall
// back to rendering the link as plain text.
//
// Allowed: http(s):, mailto:, ftp:, root-relative `/foo`, fragment `#bar`.
// Disallowed: javascript:, data:, file:, vbscript:, protocol-relative `//host`.
const DEFAULT_SAFE_LINK_PATTERN = /^(https?:|mailto:|ftp:|\/(?!\/)|#)/i;

export interface SafeHrefOptions {
  // Override the regex used to allowlist hrefs. Use sparingly —
  // widening the allowlist re-opens the XSS surface.
  pattern?: RegExp;
}

export function safeHref(
  raw: unknown,
  options: SafeHrefOptions = {},
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const pattern = options.pattern ?? DEFAULT_SAFE_LINK_PATTERN;
  return pattern.test(trimmed) ? trimmed : null;
}
