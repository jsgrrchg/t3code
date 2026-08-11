import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes an older descriptor without optional capabilities", () => {
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
    expect(decoded.capabilities.pullRequests).toBeUndefined();
    expect(decoded.capabilities.workspaceEntryMove).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    const decoded = decodeEnvironmentDescriptor({
      environmentId: "environment-1",
      label: "Local",
      platform: {
        os: "darwin",
        arch: "arm64",
      },
      serverVersion: "0.0.32",
      capabilities: {
        repositoryIdentity: true,
        pullRequests: true,
      },
    });

    expect(decoded.capabilities.pullRequests).toBe(true);
  });

  it("preserves an advertised workspace entry move capability", () => {
    const decoded = decodeEnvironmentDescriptor({
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.32",
      capabilities: {
        repositoryIdentity: true,
        workspaceEntryMove: true,
      },
    });

    expect(decoded.capabilities.workspaceEntryMove).toBe(true);
  });
});
