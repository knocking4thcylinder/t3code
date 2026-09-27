import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type VcsConfigurationInput,
  type VcsConfigurationResult,
  type VcsConfigurationWriteInput,
  type VcsError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

type Setting = VcsConfigurationWriteInput["setting"];
type Handle = VcsDriverRegistry.VcsDriverHandle;

const CONFIG_KEYS: Record<Setting, Record<"git" | "jj", string>> = {
  userName: { git: "user.name", jj: "user.name" },
  userEmail: { git: "user.email", jj: "user.email" },
  largeFile: { git: "core.bigFileThreshold", jj: "snapshot.max-new-file-size" },
};

function keyFor(handle: Handle, setting: Setting): string {
  return CONFIG_KEYS[setting][handle.kind === "jj" ? "jj" : "git"];
}

function parseRepositoryValue(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" || typeof parsed === "number" ? String(parsed) : trimmed;
  } catch {
    return trimmed;
  }
}

function validateValue(
  setting: Setting,
  value: string,
  kind: "git" | "jj",
): Effect.Effect<string, VcsUnsupportedOperationError> {
  const trimmed = value.trim();
  if (setting === "largeFile") {
    if (kind === "jj" && trimmed === "0") return Effect.succeed("0");
    const match = /^([1-9]\d{0,3})(?:\s*(?:m|mib))?$/i.exec(trimmed);
    const mebibytes = match ? Number(match[1]) : 0;
    if (mebibytes >= 1 && mebibytes <= 4096) {
      return Effect.succeed(kind === "jj" ? `${mebibytes}MiB` : `${mebibytes}m`);
    }
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsConfigurationService.write",
        kind,
        detail:
          kind === "jj"
            ? "Enter a snapshot limit between 1 and 4096 MiB, or 0 for no limit."
            : "Enter a large-file threshold between 1 and 4096 MiB.",
      }),
    );
  }
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (trimmed.length > 0 && trimmed.length <= 256 && !hasControlCharacter) {
    return Effect.succeed(trimmed);
  }
  return Effect.fail(
    new VcsUnsupportedOperationError({
      operation: "VcsConfigurationService.write",
      kind,
      detail: "Enter a name or email without control characters (up to 256 characters).",
    }),
  );
}

export class VcsConfigurationService extends Context.Service<
  VcsConfigurationService,
  {
    readonly read: (
      input: VcsConfigurationInput,
    ) => Effect.Effect<VcsConfigurationResult, VcsError>;
    readonly write: (input: VcsConfigurationWriteInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsConfigurationService") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const readValue = Effect.fn("VcsConfigurationService.readValue")(function* (
    handle: Handle,
    cwd: string,
    setting: Setting,
    repositoryOnly: boolean,
  ) {
    const key = keyFor(handle, setting);
    const isJj = handle.kind === "jj";
    const args = isJj
      ? repositoryOnly
        ? ["--ignore-working-copy", "config", "list", "--repo", key, "-T", "value"]
        : ["--ignore-working-copy", "config", "get", key]
      : ["config", ...(repositoryOnly ? ["--local"] : []), "--get", key];
    const result = yield* handle.driver.execute({
      operation: "VcsConfigurationService.read",
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: 4_096,
    });
    if (
      result.exitCode === 1 &&
      (!isJj ||
        (repositoryOnly
          ? result.stdout.trim() === ""
          : result.stderr.includes("Value not found for")))
    )
      return null;
    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "VcsConfigurationService.read",
        command: isJj ? "jj config" : "git config",
        cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "Could not read repository configuration.",
      });
    }
    if (result.stdout.trim() === "") return null;
    return repositoryOnly && isJj ? parseRepositoryValue(result.stdout) : result.stdout.trim();
  });

  const read: VcsConfigurationService["Service"]["read"] = Effect.fn(
    "VcsConfigurationService.read",
  )(function* (input) {
    const handle = yield* registry.resolve({ cwd: input.cwd });
    if (handle.kind !== "git" && handle.kind !== "jj") {
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsConfigurationService.read",
        kind: handle.kind,
        detail: "Repository configuration is available for Git and Jujutsu only.",
      });
    }
    const entry = (setting: Setting) =>
      Effect.all({
        effective: readValue(handle, input.cwd, setting, false),
        repository: readValue(handle, input.cwd, setting, true),
      });
    const values = yield* Effect.all({
      userName: entry("userName"),
      userEmail: entry("userEmail"),
      largeFile: entry("largeFile"),
    });
    return { kind: handle.kind, ...values } satisfies VcsConfigurationResult;
  });

  const write: VcsConfigurationService["Service"]["write"] = Effect.fn(
    "VcsConfigurationService.write",
  )(function* (input) {
    const handle = yield* registry.resolve({ cwd: input.cwd });
    if (handle.kind !== "git" && handle.kind !== "jj") {
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsConfigurationService.write",
        kind: handle.kind,
        detail: "Repository configuration is available for Git and Jujutsu only.",
      });
    }
    const key = keyFor(handle, input.setting);
    if (
      input.value === null &&
      (yield* readValue(handle, input.cwd, input.setting, true)) === null
    ) {
      return;
    }
    const value =
      input.value === null ? null : yield* validateValue(input.setting, input.value, handle.kind);
    const args =
      handle.kind === "jj"
        ? [
            "--ignore-working-copy",
            "config",
            value === null ? "unset" : "set",
            "--repo",
            key,
            ...(value === null ? [] : [value]),
          ]
        : [
            "config",
            "--local",
            value === null ? "--unset-all" : "--replace-all",
            key,
            ...(value === null ? [] : [value]),
          ];
    yield* handle.driver.execute({
      operation: "VcsConfigurationService.write",
      cwd: input.cwd,
      args,
      maxOutputBytes: 4_096,
    });
  });

  return VcsConfigurationService.of({ read, write });
});

export const layer = Layer.effect(VcsConfigurationService, make);
