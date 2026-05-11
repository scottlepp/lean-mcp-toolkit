// Generic HTTP client interface for SDK consumers.
//
// Each MCP server (jira-mcp, confluence-mcp, bitbucket-mcp) builds its
// own concrete client because the auth model differs (Basic vs Bearer,
// API token vs scoped token, OAuth flows, etc.). The SDK's only
// requirement is the four-verb shape below.
//
// Returns `Promise<unknown>` — callers narrow as needed. (A generic
// `<T>` return wouldn't be soundly implementable: the implementation
// has only one concrete return shape, but a generic position implies
// it can return any T the caller picks. Operations validate response
// shape via trim projections, not via the Client interface.)
//
// Servers with multi-API routing (e.g. jira's platform-vs-agile split)
// implement Client once and use the `ExecuteFn` hook on
// `invokeOperation` to decide per-operation which downstream method to
// call.

export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface Client {
  get(path: string, queryParams?: QueryParams): Promise<unknown>;
  post(path: string, body?: unknown, queryParams?: QueryParams): Promise<unknown>;
  put(path: string, body?: unknown, queryParams?: QueryParams): Promise<unknown>;
  delete(path: string, queryParams?: QueryParams): Promise<unknown>;
}
