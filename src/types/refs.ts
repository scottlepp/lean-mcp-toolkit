// Reference + summary shapes returned by the response sandbox.
//
// `SandboxResult<T>` is the primitive shape returned by `sandbox()`:
// a trimmed projection (`summary`) the agent can reason over for free,
// plus a filesystem `ref` pointing at the full JSON for when callers
// need detail. The hash/fullSize/fetchedAt fields are bookkeeping that
// callers can use to deduplicate or display sizing context.

export interface SandboxResult<TSummary> {
  summary: TSummary;
  ref: string;
  hash: string;
  fullSize: number;
  fetchedAt: string;
}

export type Ref<TSummary> = SandboxResult<TSummary>;

export type SummarizeFn<TInput, TSummary> = (input: TInput) => TSummary;

export interface SandboxOpts<TInput, TSummary> {
  // Subdirectory under the session cache where the file is written.
  // Used to cluster related responses (e.g. all "issue.get" results
  // land in `<session>/issue-get/`).
  kind: string;
  // Projection function applied to the response to produce the
  // in-band summary returned to the caller.
  summarize: SummarizeFn<TInput, TSummary>;
}
