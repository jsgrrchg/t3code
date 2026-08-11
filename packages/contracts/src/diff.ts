import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One independently parseable page of a larger diff. Providers choose the page boundary, but it
 * must fall between files so clients never need to join patches before parsing them.
 */
export const DiffSliceResult = Schema.Struct({
  patch: Schema.String,
  /** Content inside this slice that the provider could not inline. */
  truncated: Schema.Boolean,
  /** Where the next slice starts, or null once every slice is reachable. */
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type DiffSliceResult = typeof DiffSliceResult.Type;
