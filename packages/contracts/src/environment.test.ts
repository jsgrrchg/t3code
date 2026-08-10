import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes an older descriptor without the optional git history capability", () => {
    const decoded = decodeEnvironmentDescriptor({
      environmentId: "environment-1",
      label: "Local",
      platform: {
        os: "darwin",
        arch: "arm64",
      },
      serverVersion: "0.0.32",
      capabilities: {},
    });

    expect(decoded.capabilities.repositoryIdentity).toBe(false);
    expect(decoded.capabilities.gitHistory).toBeUndefined();
    expect(decoded.capabilities.gitFetchAll).toBeUndefined();
  });
});
