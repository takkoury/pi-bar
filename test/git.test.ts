import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FETCH_INTERVAL_MS, fetchArgs, fetchBackoff, GitMonitor, parseStatus } from "../src/git.ts";
import { runGit, type GitRunner } from "../src/git-process.ts";

const headers = "# branch.oid abcdef123456\0# branch.head main\0# branch.upstream review/trunk\0# branch.ab +2 -4\0";
const ordinary = (xy: string, name: string, sub = "N...") => `1 ${xy} ${sub} 100644 100644 100644 abc def ${name}\0`;

function repositoryRunner(
  options: {
    status?: () => string;
    upstream?: () => string;
    fetch?: GitRunner;
  } = {},
): GitRunner {
  return async (cwd, args, signal, timeout) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (args.includes("status")) return { code: 0, stdout: options.status?.() ?? headers, stderr: "" };
    if (args.includes("for-each-ref"))
      return {
        code: 0,
        stdout: options.upstream?.() ?? "review\0refs/heads/trunk\0refs/remotes/review/trunk\n",
        stderr: "",
      };
    assert.ok(args.includes("fetch"), `Unexpected Git command: ${args.join(" ")}`);
    assert.ok(options.fetch, "Unexpected fetch");
    return options.fetch(cwd, args, signal, timeout);
  };
}
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Git monitor");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("porcelain parser: unique files, staged+unstaged, conflicts, rename source and unusual names", () => {
  const status = parseStatus(
    headers +
      ordinary("MM", "a file\nwith newline") +
      ordinary(".M", "src/a") +
      "2 R. N... 100644 100644 100644 abc def R100 new name\0? fake-source\0" +
      "u UU N... 100644 100644 100644 100644 a b c conflict\0? new/file\0",
  );
  assert.deepEqual(
    {
      modified: status.modified,
      staged: status.staged,
      untracked: status.untracked,
      conflicts: status.conflicts,
      dirty: status.dirtyFiles,
    },
    { modified: 2, staged: 2, untracked: 1, conflicts: 1, dirty: 5 },
  );
  assert.equal(status.upstream, "review/trunk");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 4);
  assert.equal(parseStatus(ordinary("..", "submodule", "S.MU")).modified, 1);
  assert.equal(parseStatus("# branch.oid 123456789\0# branch.head (detached)\0").branch, "detached@1234567");
  assert.equal(parseStatus("# branch.oid (initial)\0# branch.head main\0").upstream, null);
});

test("scoped fetch uses configured upstream only and never pulls/prunes/tags/submodules", () => {
  const args = fetchArgs({ remote: "review", source: "refs/heads/trunk", destination: "refs/remotes/review/trunk" });
  assert.deepEqual(args.slice(-3), ["--", "review", "+refs/heads/trunk:refs/remotes/review/trunk"]);
  assert.ok(args.includes("--no-recurse-submodules"));
  assert.ok(args.includes("--no-tags"));
  assert.ok(args.includes("--no-write-fetch-head"));
  assert.ok(args.includes("--refmap="));
  assert.ok(args.includes("--no-prune"));
  assert.ok(args.includes("--no-prune-tags"));
  assert.equal(fetchBackoff(1), 180000);
  assert.equal(fetchBackoff(2), 360000);
  assert.equal(fetchBackoff(99), 1800000);
});

test("background fetch starts once, retains stale counts on failure, backs off, then recovers", async () => {
  let now = 0,
    fetches = 0,
    fail = true,
    concurrent = 0,
    maxConcurrent = 0;
  const runner: GitRunner = async (_cwd, args) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (args.includes("status")) return { code: 0, stdout: headers, stderr: "" };
    if (args.includes("for-each-ref"))
      return { code: 0, stdout: "review\0refs/heads/trunk\0refs/remotes/review/trunk\n", stderr: "" };
    fetches++;
    maxConcurrent = Math.max(maxConcurrent, ++concurrent);
    await new Promise((r) => setTimeout(r, 20));
    concurrent--;
    return { code: fail ? 1 : 0, stdout: "", stderr: fail ? "offline" : "" };
  };
  const monitor = new GitMonitor("/repo", () => {}, { runner, clock: () => now });
  try {
    await monitor.refresh();
    await monitor.refresh(true);
    await monitor.refresh(true);
    assert.equal(fetches, 1);
    await waitFor(() => monitor.snapshot.remoteState === "stale");
    assert.equal(monitor.snapshot.ahead, 2);
    assert.equal(monitor.snapshot.behind, 4);
    now = FETCH_INTERVAL_MS - 1;
    await monitor.refresh(true);
    assert.equal(fetches, 1);
    now++;
    await monitor.refresh(true);
    await waitFor(() => fetches === 2 && concurrent === 0);
    now += FETCH_INTERVAL_MS;
    await monitor.refresh(true);
    assert.equal(fetches, 2);
    now += FETCH_INTERVAL_MS;
    fail = false;
    await monitor.refresh(true);
    await waitFor(() => monitor.snapshot.remoteState === "fresh");
    assert.equal(fetches, 3);
    assert.equal(maxConcurrent, 1);
  } finally {
    await monitor.dispose();
  }
});

test("no fetch outside repositories, without upstream, or with a local upstream", async () => {
  for (const kind of ["outside", "no-upstream", "local"] as const) {
    let fetches = 0;
    const runner: GitRunner = async (_cwd, args) => {
      if (args.includes("rev-parse"))
        return { code: kind === "outside" ? 128 : 0, stdout: "/repo\n", stderr: "fatal: not a git repository" };
      if (args.includes("status"))
        return { code: 0, stdout: kind === "local" ? headers : "# branch.head main\0", stderr: "" };
      if (args.includes("for-each-ref"))
        return { code: 0, stdout: ".\0refs/heads/trunk\0refs/heads/trunk\n", stderr: "" };
      fetches++;
      return { code: 0, stdout: "", stderr: "" };
    };
    const monitor = new GitMonitor("/repo", () => {}, { runner });
    await monitor.refresh();
    await monitor.dispose();
    assert.equal(fetches, 0);
    if (kind === "outside") assert.equal(monitor.snapshot.kind, "not-repo");
    if (kind === "local") assert.equal(monitor.snapshot.remoteState, "fresh");
  }
});

test("disposal aborts network work and suppresses late UI updates", async () => {
  let updates = 0,
    aborted = false;
  const runner: GitRunner = async (_cwd, args, signal) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (args.includes("status")) return { code: 0, stdout: headers, stderr: "" };
    if (args.includes("for-each-ref"))
      return { code: 0, stdout: "review\0refs/heads/trunk\0refs/remotes/review/trunk\n", stderr: "" };
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return { code: -1, stdout: "", stderr: "cancelled", killed: true };
  };
  const monitor = new GitMonitor(
    "/repo",
    () => {
      updates++;
    },
    { runner },
  );
  await monitor.refresh();
  const before = updates;
  await monitor.dispose();
  await monitor.dispose();
  assert.equal(aborted, true);
  assert.equal(updates, before);
});

test(
  "actual git: unborn, renamed/dirty files, configured upstream fetch, divergence, detached and conflicts",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bar-git-"));
    const work = join(root, "work"),
      bare = join(root, "remote.git"),
      peer = join(root, "peer"),
      hooks = join(root, "empty-hooks");
    await mkdir(work);
    await mkdir(hooks);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          `core.hooksPath=${hooks}`,
          "-c",
          "user.name=pi-bar Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    let monitor: GitMonitor | undefined;
    try {
      git(work, "init", "-b", "main");
      assert.equal(parseStatus(git(work, "status", "--porcelain=v2", "--branch", "-z")).branch, "main");
      await writeFile(join(work, "file.txt"), "base\n");
      git(work, "add", ".");
      git(work, "commit", "-m", "base");
      git(root, "init", "--bare", bare);
      git(work, "remote", "add", "review", bare);
      git(work, "push", "-u", "review", "main:trunk");
      git(root, "clone", "-b", "trunk", bare, peer);
      await writeFile(join(peer, "remote.txt"), "remote change\n");
      git(peer, "add", ".");
      git(peer, "commit", "-m", "remote");
      git(peer, "push");
      await writeFile(join(work, "local.txt"), "local change\n");
      git(work, "add", ".");
      git(work, "commit", "-m", "local");
      git(work, "mv", "file.txt", "renamed file.txt");
      await writeFile(join(work, "renamed file.txt"), "base\nmore\n");
      await writeFile(join(work, "untracked.txt"), "untracked\n");
      const before = git(work, "status", "--porcelain=v2", "-z");
      // A configured but missing tracking ref must be fetched, never reported as synced.
      git(work, "update-ref", "-d", "refs/remotes/review/trunk");
      // User fetch configuration must not turn a status refresh into tag pruning/fetching.
      git(work, "tag", "local-only");
      git(peer, "tag", "remote-only");
      git(peer, "push", "origin", "--tags");
      git(work, "config", "fetch.prune", "true");
      git(work, "config", "fetch.pruneTags", "true");
      git(work, "config", "remote.review.prune", "true");
      git(work, "config", "remote.review.pruneTags", "true");
      monitor = new GitMonitor(work, () => {});
      await monitor.refresh();
      await waitFor(() => monitor!.snapshot.remoteState === "fresh" && monitor!.snapshot.behind === 1);
      assert.equal(monitor.snapshot.upstream, "review/trunk");
      assert.equal(monitor.snapshot.ahead, 1);
      assert.equal(monitor.snapshot.dirtyFiles, 2);
      assert.equal(monitor.snapshot.staged, 1);
      assert.equal(monitor.snapshot.modified, 1);
      assert.equal(git(work, "status", "--porcelain=v2", "-z"), before); // Fetch never modifies index/worktree.
      assert.equal(git(work, "tag", "--list").trim(), "local-only");
      await monitor.dispose();
      monitor = undefined;
      git(work, "reset", "--hard", "HEAD");
      git(work, "checkout", "--detach");
      assert.match(parseStatus(git(work, "status", "--porcelain=v2", "--branch", "-z")).branch, /^detached@/);
      git(work, "checkout", "main");
      git(work, "checkout", "-b", "conflicting");
      await writeFile(join(work, "file.txt"), "one\n");
      git(work, "add", "file.txt");
      git(work, "commit", "-m", "one");
      git(work, "checkout", "main");
      await writeFile(join(work, "file.txt"), "two\n");
      git(work, "add", "file.txt");
      git(work, "commit", "-m", "two");
      assert.throws(() => git(work, "merge", "conflicting"));
      const conflict = parseStatus(git(work, "status", "--porcelain=v2", "--branch", "-z"));
      assert.equal(conflict.conflicts, 1);
      assert.equal(conflict.dirtyFiles, 2); // Conflict + untracked file.
    } finally {
      await monitor?.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test("offline mode retains cached comparison without fetching", async () => {
  let fetched = false;
  const runner: GitRunner = async (_cwd, args) => {
    if (args.includes("rev-parse")) return { code: 0, stdout: "/repo\n", stderr: "" };
    if (args.includes("status")) return { code: 0, stdout: headers, stderr: "" };
    if (args.includes("for-each-ref"))
      return { code: 0, stdout: "review\0refs/heads/trunk\0refs/remotes/review/trunk\n", stderr: "" };
    fetched = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const monitor = new GitMonitor("/repo", () => {}, { runner, fetchEnabled: false });
  await monitor.refresh();
  await monitor.dispose();
  assert.equal(fetched, false);
  assert.equal(monitor.snapshot.remoteState, "cached");
  assert.equal(monitor.snapshot.ahead, 2);
});

test("timeout terminates a Git subprocess tree without waiting for its child", { timeout: 5000 }, async () => {
  const started = Date.now();
  const result = await runGit(
    tmpdir(),
    ["-c", "alias.statusline-wait=!sleep 30", "statusline-wait"],
    new AbortController().signal,
    150,
  );
  assert.equal(result.killed, true);
  assert.ok(Date.now() - started < 4000);
});

test("process wrapper handles a missing cwd and pre-aborted commands", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runGit(tmpdir(), ["status"], controller.signal)).killed, true);
  assert.notEqual(
    (await runGit(join(tmpdir(), "pi-bar-does-not-exist"), ["status"], new AbortController().signal)).code,
    0,
  );
});

test("ordinary branches beginning with detached@ still resolve and fetch their upstream", async () => {
  let fetches = 0;
  const monitor = new GitMonitor("/repo", () => {}, {
    runner: repositoryRunner({
      status: () => headers.replace("branch.head main", "branch.head detached@topic"),
      fetch: async () => {
        fetches++;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  });
  try {
    await monitor.refresh();
    await waitFor(() => monitor.snapshot.remoteState === "fresh");
    assert.equal(fetches, 1);
    assert.equal(monitor.snapshot.branch, "detached@topic");
  } finally {
    await monitor.dispose();
  }
});

test("unsafe upstream destinations never overwrite local branches or tags", async () => {
  for (const destination of ["refs/heads/main", "refs/tags/v1"]) {
    let fetches = 0;
    const monitor = new GitMonitor("/repo", () => {}, {
      runner: repositoryRunner({
        upstream: () => `review\0refs/heads/trunk\0${destination}\n`,
        fetch: async () => {
          fetches++;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    });
    try {
      await monitor.refresh();
      assert.equal(fetches, 0);
      assert.equal(monitor.snapshot.remoteState, "stale");
    } finally {
      await monitor.dispose();
    }
  }
});

test("changing upstream cancels the old fetch and ignores its late result", async () => {
  let branch = "main";
  let aborted = false;
  const destinations: string[] = [];
  const monitor = new GitMonitor("/repo", () => {}, {
    runner: repositoryRunner({
      status: () => headers.replace("branch.head main", `branch.head ${branch}`),
      upstream: () => `review\0refs/heads/${branch}\0refs/remotes/review/${branch}\n`,
      fetch: async (_cwd, args, signal) => {
        destinations.push(args.at(-1)!);
        if (destinations.length === 1) {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          return { code: 1, stdout: "", stderr: "old target failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  });
  try {
    await monitor.refresh();
    branch = "next";
    await monitor.refresh(true);
    await waitFor(() => monitor.snapshot.remoteState === "fresh");
    assert.equal(aborted, true);
    assert.deepEqual(destinations, [
      "+refs/heads/main:refs/remotes/review/main",
      "+refs/heads/next:refs/remotes/review/next",
    ]);
    assert.equal(monitor.snapshot.branch, "next");
  } finally {
    await monitor.dispose();
  }
});

test("concurrent disposals share the same cleanup promise", async () => {
  const finished = Promise.withResolvers<void>();
  let aborted = false;
  const monitor = new GitMonitor("/repo", () => {}, {
    runner: repositoryRunner({
      fetch: async (_cwd, _args, signal) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        await finished.promise;
        return { code: -1, stdout: "", stderr: "cancelled", killed: true };
      },
    }),
  });
  try {
    await monitor.refresh();
    const first = monitor.dispose();
    const second = monitor.dispose();
    assert.equal(aborted, true);
    assert.equal(first, second);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    finished.resolve();
    await Promise.all([first, second]);
  } finally {
    finished.resolve();
    await monitor.dispose();
  }
});

test("process output is bounded even when a command exceeds the buffer limit", { timeout: 5000 }, async () => {
  const result = await runGit(
    tmpdir(),
    ["-c", "alias.statusline-output=!printf '%3145728s' x", "statusline-output"],
    new AbortController().signal,
  );
  assert.equal(result.killed, true);
  assert.equal(result.code, -1);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 2 * 1024 * 1024);
});
