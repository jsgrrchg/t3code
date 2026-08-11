// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { ResourceMonitorHostLinuxLibc } from "../resourceTelemetry/ResourceMonitorBinary.ts";
import { moveWorkspaceEntrySecurely, SecureWorkspaceMoveError } from "./SecureWorkspaceMove.ts";

type TestRuntime = Pick<
  Parameters<typeof moveWorkspaceEntrySecurely>[0],
  "platform" | "architecture" | "linuxLibc"
>;

const posixTest = (name: string, test: (runtime: TestRuntime) => Promise<void>) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform !== "darwin" && platform !== "linux") return;
      const architecture = yield* HostProcessArchitecture;
      const linuxLibc = platform === "linux" ? yield* ResourceMonitorHostLinuxLibc : undefined;
      yield* Effect.promise(() =>
        test({
          platform,
          architecture,
          ...(linuxLibc === undefined ? {} : { linuxLibc }),
        }),
      );
    }),
  );

describe("moveWorkspaceEntrySecurely", () => {
  posixTest(
    "keeps mutations attached to opened parents when their paths are replaced",
    async (runtime) => {
      const workspaceRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-secure-move-"),
      );
      const outsideRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-secure-move-outside-"),
      );
      const sourceParent = NodePath.join(workspaceRoot, "source");
      const destinationParent = NodePath.join(workspaceRoot, "destination");
      const anchoredSourceParent = NodePath.join(workspaceRoot, "anchored-source");
      const anchoredDestinationParent = NodePath.join(workspaceRoot, "anchored-destination");
      const outsideSourceParent = NodePath.join(outsideRoot, "source");
      const outsideDestinationParent = NodePath.join(outsideRoot, "destination");

      await Promise.all([
        NodeFSP.mkdir(sourceParent),
        NodeFSP.mkdir(destinationParent),
        NodeFSP.mkdir(outsideSourceParent),
        NodeFSP.mkdir(outsideDestinationParent),
      ]);
      await NodeFSP.writeFile(NodePath.join(sourceParent, "file.txt"), "workspace\n");
      await NodeFSP.writeFile(NodePath.join(outsideSourceParent, "file.txt"), "outside\n");

      try {
        await moveWorkspaceEntrySecurely({
          ...runtime,
          workspaceRoot,
          sourceRelativePath: "source/file.txt",
          destinationRelativePath: "destination/file.txt",
          onDirectoriesOpened: async () => {
            await NodeFSP.rename(sourceParent, anchoredSourceParent);
            await NodeFSP.rename(destinationParent, anchoredDestinationParent);
            await NodeFSP.symlink(outsideSourceParent, sourceParent);
            await NodeFSP.symlink(outsideDestinationParent, destinationParent);
          },
        });

        await expect(
          NodeFSP.readFile(NodePath.join(anchoredDestinationParent, "file.txt"), "utf8"),
        ).resolves.toBe("workspace\n");
        await expect(
          NodeFSP.lstat(NodePath.join(anchoredSourceParent, "file.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          NodeFSP.readFile(NodePath.join(outsideSourceParent, "file.txt"), "utf8"),
        ).resolves.toBe("outside\n");
        await expect(
          NodeFSP.lstat(NodePath.join(outsideDestinationParent, "file.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await Promise.all([
          NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
          NodeFSP.rm(outsideRoot, { recursive: true, force: true }),
        ]);
      }
    },
  );

  posixTest(
    "rejects a parent symlink that resolves outside the opened workspace",
    async (runtime) => {
      const workspaceRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-secure-move-"),
      );
      const outsideRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-secure-move-outside-"),
      );
      await NodeFSP.writeFile(NodePath.join(workspaceRoot, "file.txt"), "workspace\n");
      await NodeFSP.symlink(outsideRoot, NodePath.join(workspaceRoot, "outside"));

      try {
        await expect(
          moveWorkspaceEntrySecurely({
            ...runtime,
            workspaceRoot,
            sourceRelativePath: "file.txt",
            destinationRelativePath: "outside/file.txt",
          }),
        ).rejects.toMatchObject({
          failure: "path-escape",
        } satisfies Partial<SecureWorkspaceMoveError>);
        await expect(NodeFSP.lstat(NodePath.join(outsideRoot, "file.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await Promise.all([
          NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
          NodeFSP.rm(outsideRoot, { recursive: true, force: true }),
        ]);
      }
    },
  );
});
