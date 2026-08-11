import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  isClerkPublishableKeySupportedForRuntime,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isClerkPublishableKeySupportedForRuntime", () => {
  it("rejects production keys in the hot desktop renderer", () => {
    expect(
      isClerkPublishableKeySupportedForRuntime({
        publishableKey: "pk_live_example",
        isElectron: true,
        protocol: "t3code-dev:",
      }),
    ).toBe(false);
  });

  it("allows development keys in the hot desktop renderer", () => {
    expect(
      isClerkPublishableKeySupportedForRuntime({
        publishableKey: "pk_test_example",
        isElectron: true,
        protocol: "t3code-dev:",
      }),
    ).toBe(true);
  });

  it("preserves production Clerk for packaged desktop and web clients", () => {
    expect(
      isClerkPublishableKeySupportedForRuntime({
        publishableKey: "pk_live_example",
        isElectron: true,
        protocol: "t3code:",
      }),
    ).toBe(true);
    expect(
      isClerkPublishableKeySupportedForRuntime({
        publishableKey: "pk_live_example",
        isElectron: false,
        protocol: "https:",
      }),
    ).toBe(true);
  });
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});
