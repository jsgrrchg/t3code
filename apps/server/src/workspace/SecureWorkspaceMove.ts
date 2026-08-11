// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { DataType, load, open } from "ffi-rs";

const LIBRARY_NAME = "t3-secure-workspace-move";
const MAX_SYMLINKS = 40;
const READLINK_BUFFER_BYTES = 16 * 1024;

type SecureWorkspaceMoveFailure =
  | "destination-exists"
  | "destination-parent-not-directory"
  | "destination-parent-not-found"
  | "operation-failed"
  | "path-escape"
  | "source-kind-mismatch"
  | "source-not-found"
  | "unsupported-platform";

export class SecureWorkspaceMoveError extends Error {
  readonly failure: SecureWorkspaceMoveFailure;
  readonly operationPath: string;
  readonly code?: string;

  constructor(
    failure: SecureWorkspaceMoveFailure,
    operationPath: string,
    message: string,
    options?: ErrorOptions & { readonly code?: string },
  ) {
    super(message, options);
    this.name = "SecureWorkspaceMoveError";
    this.failure = failure;
    this.operationPath = operationPath;
    if (options?.code !== undefined) this.code = options.code;
  }
}

type NativeResult = {
  readonly value: number;
  readonly errnoCode: number;
  readonly errnoMessage: string;
};

let libcOpened = false;

function libcPath(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly linuxLibc?: "gnu" | "musl" | undefined;
}): string {
  if (input.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (input.platform !== "linux") {
    throw new SecureWorkspaceMoveError(
      "unsupported-platform",
      input.platform,
      `Secure workspace moves are unsupported on ${input.platform}.`,
    );
  }
  if (input.linuxLibc === "gnu") return "libc.so.6";
  const muslArch =
    input.architecture === "arm64" ? "aarch64" : input.architecture === "x64" ? "x86_64" : "";
  if (muslArch.length === 0) {
    throw new SecureWorkspaceMoveError(
      "unsupported-platform",
      `${input.platform}/${input.architecture}`,
      `Secure workspace moves are unsupported on ${input.platform}/${input.architecture}.`,
    );
  }
  return `/lib/ld-musl-${muslArch}.so.1`;
}

function ensureLibcOpened(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly linuxLibc?: "gnu" | "musl" | undefined;
}): void {
  if (libcOpened) return;
  open({ library: LIBRARY_NAME, path: libcPath(input) });
  libcOpened = true;
}

function callNative(input: {
  readonly funcName: string;
  readonly retType: DataType;
  readonly paramsType: ReadonlyArray<DataType>;
  readonly paramsValue: ReadonlyArray<unknown>;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly linuxLibc?: "gnu" | "musl" | undefined;
}): NativeResult {
  ensureLibcOpened(input);
  return load({
    library: LIBRARY_NAME,
    funcName: input.funcName,
    retType: input.retType,
    paramsType: [...input.paramsType],
    paramsValue: [...input.paramsValue],
    errno: true,
  }) as NativeResult;
}

function errnoCode(errno: number): string {
  try {
    return NodeUtil.getSystemErrorName(-errno);
  } catch {
    return `ERRNO_${errno}`;
  }
}

function nativeError(result: NativeResult, operationPath: string, operation: string) {
  const code = errnoCode(result.errnoCode);
  return new SecureWorkspaceMoveError(
    "operation-failed",
    operationPath,
    `${operation} failed for '${operationPath}': ${result.errnoMessage}`,
    { code },
  );
}

type NativeRuntime = {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly linuxLibc?: "gnu" | "musl" | undefined;
};

function closeDescriptor(runtime: NativeRuntime, descriptor: number): void {
  callNative({
    ...runtime,
    funcName: "close",
    retType: DataType.I32,
    paramsType: [DataType.I32],
    paramsValue: [descriptor],
  });
}

function splitRelativePath(relativePath: string): Array<string> {
  return relativePath
    .split(NodePath.sep)
    .filter((component) => component.length > 0 && component !== ".");
}

function normalizeComponents(components: ReadonlyArray<string>, operationPath: string) {
  const normalized: Array<string> = [];
  for (const component of components) {
    if (component === "." || component.length === 0) continue;
    if (component === "..") {
      if (normalized.length === 0) {
        throw new SecureWorkspaceMoveError(
          "path-escape",
          operationPath,
          `Workspace symlink escapes its root while resolving '${operationPath}'.`,
        );
      }
      normalized.pop();
      continue;
    }
    normalized.push(component);
  }
  return normalized;
}

function readLinkAt(
  runtime: NativeRuntime,
  directoryDescriptor: number,
  component: string,
  operationPath: string,
): string {
  const buffer = Buffer.alloc(READLINK_BUFFER_BYTES);
  const result = callNative({
    ...runtime,
    funcName: "readlinkat",
    retType: DataType.I64,
    paramsType: [DataType.I32, DataType.String, DataType.U8Array, DataType.U64],
    paramsValue: [directoryDescriptor, component, buffer, buffer.length],
  });
  if (result.value < 0) throw nativeError(result, operationPath, "readlinkat");
  if (result.value === buffer.length) {
    throw new SecureWorkspaceMoveError(
      "operation-failed",
      operationPath,
      `Workspace symlink target is too long at '${operationPath}'.`,
      { code: "ENAMETOOLONG" },
    );
  }
  return buffer.subarray(0, result.value).toString();
}

function openDirectoryAt(
  runtime: NativeRuntime,
  directoryDescriptor: number,
  component: string,
): NativeResult {
  return callNative({
    ...runtime,
    funcName: "openat",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.String, DataType.I32],
    paramsValue: [
      directoryDescriptor,
      component,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
    ],
  });
}

function parentFailure(
  parentKind: "source" | "destination",
  code: string,
): SecureWorkspaceMoveFailure {
  if (parentKind === "source") return "source-not-found";
  if (code === "ENOTDIR") return "destination-parent-not-directory";
  return "destination-parent-not-found";
}

function openParentDirectory(input: {
  readonly runtime: NativeRuntime;
  readonly rootDescriptor: number;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly parentKind: "source" | "destination";
}): number {
  const parentRelativePath = NodePath.dirname(input.relativePath);
  let pending = splitRelativePath(parentRelativePath);
  let resolved: Array<string> = [];
  let openedDescriptors: Array<number> = [];
  let currentDescriptor = input.rootDescriptor;
  let symlinkCount = 0;

  const restartFromRoot = () => {
    for (const descriptor of openedDescriptors.toReversed()) {
      closeDescriptor(input.runtime, descriptor);
    }
    openedDescriptors = [];
    currentDescriptor = input.rootDescriptor;
    resolved = [];
  };

  try {
    while (pending.length > 0) {
      const component = pending.shift()!;
      const operationPath = NodePath.join(
        input.workspaceRoot,
        resolved.join(NodePath.sep),
        component,
      );
      const opened = openDirectoryAt(input.runtime, currentDescriptor, component);
      if (opened.value >= 0) {
        currentDescriptor = opened.value;
        openedDescriptors.push(opened.value);
        resolved.push(component);
        continue;
      }

      const code = errnoCode(opened.errnoCode);
      if (code !== "ELOOP" && code !== "ENOTDIR") {
        if (code === "ENOENT") {
          throw new SecureWorkspaceMoveError(
            parentFailure(input.parentKind, code),
            operationPath,
            `Workspace move parent is unavailable at '${operationPath}'.`,
            { code },
          );
        }
        throw nativeError(opened, operationPath, "openat");
      }

      symlinkCount += 1;
      if (symlinkCount > MAX_SYMLINKS) {
        throw new SecureWorkspaceMoveError(
          "operation-failed",
          operationPath,
          `Too many workspace symlinks while resolving '${operationPath}'.`,
          { code: "ELOOP" },
        );
      }
      let target: string;
      try {
        target = readLinkAt(input.runtime, currentDescriptor, component, operationPath);
      } catch (cause) {
        if (
          code === "ENOTDIR" &&
          cause instanceof SecureWorkspaceMoveError &&
          cause.code === "EINVAL"
        ) {
          throw new SecureWorkspaceMoveError(
            parentFailure(input.parentKind, code),
            operationPath,
            `Workspace move parent is not a directory at '${operationPath}'.`,
            { code },
          );
        }
        throw cause;
      }
      const targetComponents = NodePath.isAbsolute(target)
        ? (() => {
            const relativeTarget = NodePath.relative(NodePath.resolve(input.workspaceRoot), target);
            if (
              relativeTarget === ".." ||
              relativeTarget.startsWith(`..${NodePath.sep}`) ||
              NodePath.isAbsolute(relativeTarget)
            ) {
              throw new SecureWorkspaceMoveError(
                "path-escape",
                operationPath,
                `Workspace symlink '${operationPath}' resolves outside its root.`,
              );
            }
            return splitRelativePath(relativeTarget);
          })()
        : normalizeComponents([...resolved, ...splitRelativePath(target)], operationPath);
      pending = targetComponents.concat(pending);
      restartFromRoot();
    }

    if (openedDescriptors.length === 0) return input.rootDescriptor;
    const result = openedDescriptors.pop()!;
    for (const descriptor of openedDescriptors.toReversed()) {
      closeDescriptor(input.runtime, descriptor);
    }
    return result;
  } catch (cause) {
    for (const descriptor of openedDescriptors.toReversed()) {
      closeDescriptor(input.runtime, descriptor);
    }
    throw cause;
  }
}

function linkAt(input: {
  readonly runtime: NativeRuntime;
  readonly sourceDescriptor: number;
  readonly sourceName: string;
  readonly destinationDescriptor: number;
  readonly destinationName: string;
}): NativeResult {
  return callNative({
    ...input.runtime,
    funcName: "linkat",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.String, DataType.I32, DataType.String, DataType.I32],
    paramsValue: [
      input.sourceDescriptor,
      input.sourceName,
      input.destinationDescriptor,
      input.destinationName,
      0,
    ],
  });
}

function unlinkAt(runtime: NativeRuntime, directoryDescriptor: number, name: string): NativeResult {
  return callNative({
    ...runtime,
    funcName: "unlinkat",
    retType: DataType.I32,
    paramsType: [DataType.I32, DataType.String, DataType.I32],
    paramsValue: [directoryDescriptor, name, 0],
  });
}

export async function moveWorkspaceEntrySecurely(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly linuxLibc?: "gnu" | "musl" | undefined;
  readonly workspaceRoot: string;
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
  readonly onDirectoriesOpened?: (() => Promise<void>) | undefined;
}): Promise<void> {
  const runtime: NativeRuntime = {
    platform: input.platform,
    architecture: input.architecture,
    ...(input.linuxLibc === undefined ? {} : { linuxLibc: input.linuxLibc }),
  };
  if (input.platform !== "darwin" && input.platform !== "linux") {
    throw new SecureWorkspaceMoveError(
      "unsupported-platform",
      input.platform,
      `Secure workspace moves are unsupported on ${input.platform}.`,
    );
  }

  let rootHandle: NodeFSP.FileHandle | undefined;
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    rootHandle = await NodeFSP.open(
      input.workspaceRoot,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY,
    );
    sourceDescriptor = openParentDirectory({
      runtime,
      rootDescriptor: rootHandle.fd,
      workspaceRoot: input.workspaceRoot,
      relativePath: input.sourceRelativePath,
      parentKind: "source",
    });
    destinationDescriptor = openParentDirectory({
      runtime,
      rootDescriptor: rootHandle.fd,
      workspaceRoot: input.workspaceRoot,
      relativePath: input.destinationRelativePath,
      parentKind: "destination",
    });
    await input.onDirectoriesOpened?.();

    const sourceName = NodePath.basename(input.sourceRelativePath);
    const destinationName = NodePath.basename(input.destinationRelativePath);
    const result = linkAt({
      runtime,
      sourceDescriptor,
      sourceName,
      destinationDescriptor,
      destinationName,
    });
    if (result.value < 0) {
      const code = errnoCode(result.errnoCode);
      const operationPath = NodePath.join(input.workspaceRoot, input.destinationRelativePath);
      if (code === "EEXIST") {
        throw new SecureWorkspaceMoveError(
          "destination-exists",
          operationPath,
          `Workspace move destination already exists at '${operationPath}'.`,
          { code },
        );
      }
      if (code === "ENOENT") {
        throw new SecureWorkspaceMoveError(
          "source-not-found",
          NodePath.join(input.workspaceRoot, input.sourceRelativePath),
          `Workspace move source is unavailable at '${input.sourceRelativePath}'.`,
          { code },
        );
      }
      if (code === "EISDIR" || code === "EPERM") {
        throw new SecureWorkspaceMoveError(
          "source-kind-mismatch",
          NodePath.join(input.workspaceRoot, input.sourceRelativePath),
          `Workspace move source is not a file at '${input.sourceRelativePath}'.`,
          { code },
        );
      }
      throw nativeError(result, operationPath, "linkat");
    }

    const removal = unlinkAt(runtime, sourceDescriptor, sourceName);
    if (removal.value < 0) {
      const rollback = unlinkAt(runtime, destinationDescriptor, destinationName);
      const operationPath = NodePath.join(input.workspaceRoot, input.sourceRelativePath);
      if (rollback.value < 0) {
        throw new SecureWorkspaceMoveError(
          "operation-failed",
          NodePath.join(input.workspaceRoot, input.destinationRelativePath),
          `unlinkat failed for the source and its destination rollback also failed.`,
          {
            code: errnoCode(rollback.errnoCode),
            cause: new AggregateError([
              nativeError(removal, operationPath, "unlinkat"),
              nativeError(rollback, input.destinationRelativePath, "rollback unlinkat"),
            ]),
          },
        );
      }
      throw nativeError(removal, operationPath, "unlinkat");
    }
  } catch (cause) {
    if (cause instanceof SecureWorkspaceMoveError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    throw new SecureWorkspaceMoveError(
      "operation-failed",
      input.workspaceRoot,
      `Secure workspace move failed in '${input.workspaceRoot}'.`,
      {
        cause,
        ...(code === undefined ? {} : { code }),
      },
    );
  } finally {
    if (sourceDescriptor !== undefined && sourceDescriptor !== rootHandle?.fd) {
      closeDescriptor(runtime, sourceDescriptor);
    }
    if (
      destinationDescriptor !== undefined &&
      destinationDescriptor !== rootHandle?.fd &&
      destinationDescriptor !== sourceDescriptor
    ) {
      closeDescriptor(runtime, destinationDescriptor);
    }
    await rootHandle?.close();
  }
}
