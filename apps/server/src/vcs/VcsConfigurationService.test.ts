import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as VcsConfigurationService from "./VcsConfigurationService.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { createJjRepo, describeJj, runGit, runJj } from "./testing/JjTestSupport.ts";

const TestLayer = VcsConfigurationService.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads, writes, and resets guided Git repository configuration", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-config-" });
    yield* runGit(root, ["init", "--initial-branch=main"]);
    const configuration = yield* VcsConfigurationService.VcsConfigurationService;

    yield* configuration.write({ cwd: root, setting: "userName", value: "Repository Author" });
    yield* configuration.write({ cwd: root, setting: "largeFile", value: "4 MiB" });
    const saved = yield* configuration.read({ cwd: root });
    assert.equal(saved.kind, "git");
    assert.equal(saved.userName.repository, "Repository Author");
    assert.equal(saved.largeFile.repository, "4m");
    assert.equal(
      (yield* runGit(root, ["config", "--local", "--get", "core.bigFileThreshold"])).trim(),
      "4m",
    );

    yield* configuration.write({ cwd: root, setting: "largeFile", value: null });
    assert.equal((yield* configuration.read({ cwd: root })).largeFile.repository, null);
    const failure = yield* configuration
      .write({ cwd: root, setting: "largeFile", value: "5000" })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "VcsUnsupportedOperationError");
  }).pipe(Effect.provide(TestLayer)),
);

describeJj("Jujutsu repository configuration", () => {
  it.effect("raises the new-file snapshot limit and restores inheritance", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-config-" });
      yield* createJjRepo(root);
      const largeFile = `${root}/large.txt`;
      yield* fileSystem.writeFileString(largeFile, "x".repeat(2 * 1024 * 1024));
      const before = yield* runJj(root, ["file", "list"]);
      assert.isFalse(before.includes("large.txt"));

      const configuration = yield* VcsConfigurationService.VcsConfigurationService;
      yield* configuration.write({ cwd: root, setting: "largeFile", value: "4" });
      const saved = yield* configuration.read({ cwd: root });
      assert.equal(saved.kind, "jj");
      assert.equal(saved.largeFile.repository, "4MiB");
      assert.isTrue((yield* runJj(root, ["file", "list"])).includes("large.txt"));

      yield* configuration.write({ cwd: root, setting: "largeFile", value: "0" });
      assert.equal((yield* configuration.read({ cwd: root })).largeFile.repository, "0");

      yield* configuration.write({ cwd: root, setting: "largeFile", value: null });
      assert.equal((yield* configuration.read({ cwd: root })).largeFile.repository, null);
    }).pipe(Effect.provide(TestLayer)),
  );
});
