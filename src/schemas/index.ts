// Shared Zod schema helpers for numeric fields.
//
// LLM-callable tools routinely receive numeric fields as JSON strings
// (`"39636"` instead of `39636`) because the inputSchema doesn't yet
// advertise field types. Use `preprocess` to convert strings to
// numbers BEFORE the type check — this gives a clear error for
// genuinely missing / non-numeric input instead of `received NaN`.

import { z } from "zod";

const toNumberIfString = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? Number(v) : v;

/** Positive integer (e.g. pr_id, page). Accepts number or numeric string. */
export const positiveInt = z.preprocess(
  toNumberIfString,
  z
    .number({ message: "must be a number or numeric string (e.g. 39636 or \"39636\")" })
    .int("must be an integer")
    .positive("must be positive"),
);

/** Non-negative integer (e.g. context_lines). Accepts number or numeric string. */
export const nonNegativeInt = z.preprocess(
  toNumberIfString,
  z
    .number({ message: "must be a number or numeric string" })
    .int("must be an integer")
    .nonnegative("must be ≥ 0"),
);
