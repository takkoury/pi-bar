import { basename } from "node:path";
import { runGit, type GitRunner } from "./git-process.ts";

interface GitStatus {
  branch: string;
  oid: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  modified: number;
  staged: number;
  untracked: number;
  conflicts: number;
  dirtyFiles: number;
}

/** Porcelain v2 -z is safe for whitespace/newlines in filenames and rename source records. */
export function parseStatus(output: string): GitStatus {
  const status: GitStatus = {
    branch: "",
    oid: "",
    upstream: null,
    ahead: null,
    behind: null,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicts: 0,
    dirtyFiles: 0,
  };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# branch.head ")) status.branch = record.slice(14);
    else if (record.startsWith("# branch.oid ")) status.oid = record.slice(13);
    else if (record.startsWith("# branch.upstream ")) status.upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (record.startsWith("? ")) {
      status.untracked++;
      status.dirtyFiles++;
    } else if (record.startsWith("u ")) {
      status.conflicts++;
      status.dirtyFiles++;
    } else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const xy = record.slice(2, 4),
        sub = record.slice(5, 9);
      status.dirtyFiles++;
      if (xy[0] !== ".") status.staged++;
      if (xy[1] !== "." || (sub.startsWith("S") && sub.slice(2) !== "..")) status.modified++;
      if (record[0] === "2") i++; // Original filename is a separate NUL record, not a second dirty file.
    }
  }
  if (status.branch === "(detached)") status.branch = `detached@${status.oid.slice(0, 7)}`;
  return status;
}

type RemoteState = "cached" | "fetching" | "fresh" | "stale";
export interface GitSnapshot extends GitStatus {
  kind: "loading" | "repo" | "not-repo" | "error";
  repo: string;
  root: string | null;
  remoteState: RemoteState;
  localStale: boolean;
}
export const emptyGit = (cwd: string): GitSnapshot => ({
  ...parseStatus(""),
  kind: "loading",
  repo: basename(cwd) || cwd,
  root: null,
  remoteState: "cached",
  localStale: false,
});

interface Upstream {
  key: string;
  remote: string;
  source: string;
  destination: string;
  root: string;
}
const FETCH_INTERVAL_MS = 180_000;
const MAX_FETCH_BACKOFF_MS = 1_800_000;
const FETCH_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 5_000;
const REFRESH_THROTTLE_MS = 300;

const fetchBackoff = (failures: number): number =>
  Math.min(FETCH_INTERVAL_MS * 2 ** Math.max(0, failures - 1), MAX_FETCH_BACKOFF_MS);

function fetchArgs({ remote, source, destination }: Upstream): string[] {
  return [
    "-c",
    "credential.interactive=false",
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-prune",
    "--no-prune-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--refmap=",
    "--",
    remote,
    `+${source}:${destination}`,
  ];
}

interface GitMonitorOptions {
  runner?: GitRunner;
  clock?: () => number;
  fetchEnabled?: boolean;
}

/** Local polling and network refresh are independent; neither blocks footer render or model events. */
export class GitMonitor {
  snapshot: GitSnapshot;
  private readonly cwd: string;
  private readonly changed: () => void;
  private readonly runner: GitRunner;
  private readonly clock: () => number;
  private readonly fetchEnabled: boolean;
  private readonly controller = new AbortController();
  private fetchController: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private fetchPromise: Promise<void> | null = null;
  private target: Upstream | null = null;
  private nextFetch = 0;
  private failures = 0;
  private lastCheck = -Infinity;
  private stopped = false;
  private disposePromise: Promise<void> | null = null;

  constructor(cwd: string, changed: () => void, options: GitMonitorOptions = {}) {
    this.cwd = cwd;
    this.changed = changed;
    this.runner = options.runner ?? runGit;
    this.clock = options.clock ?? Date.now;
    this.fetchEnabled = options.fetchEnabled ?? true;
    this.snapshot = emptyGit(cwd);
  }

  start(): void {
    if (this.stopped || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  /** Event bursts are throttled; the five-second poll also catches external edits and user bash. */
  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && this.clock() - this.lastCheck < REFRESH_THROTTLE_MS) return Promise.resolve();
    this.lastCheck = this.clock();
    this.refreshPromise = this.readLocal()
      .catch(() => {
        if (this.stopped) return;
        this.snapshot = { ...this.snapshot, localStale: true, kind: this.snapshot.root ? "repo" : "error" };
        this.changed();
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async readLocal(): Promise<void> {
    const signal = this.controller.signal;
    const rootResult = await this.runner(this.cwd, ["rev-parse", "--show-toplevel"], signal);
    if (this.stopped) return;
    if (rootResult.killed || rootResult.code !== 0) {
      // Only a definitive result should discard the last known repository and upstream.
      if (rootResult.killed || !/not a git repository|must be run in a work tree/i.test(rootResult.stderr)) {
        throw new Error("Git work tree unavailable");
      }
      this.setTarget(null);
      this.snapshot = { ...emptyGit(this.cwd), kind: "not-repo" };
      this.changed();
      return;
    }
    const root = rootResult.stdout.replace(/[\r\n]+$/, "");
    const result = await this.runner(
      root,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      signal,
    );
    if (this.stopped) return;
    if (result.code !== 0 || result.killed) throw new Error("Git status unavailable");
    const status = parseStatus(result.stdout);
    // Resolve the upstream's actual remote/refspec, never assume origin or matching branch names.
    let target: Upstream | null = null;
    if (status.upstream) {
      const ref = await this.runner(
        root,
        [
          "for-each-ref",
          "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
          `refs/heads/${status.branch}`,
        ],
        signal,
      );
      if (this.stopped) return;
      const [remote, source, destination] = ref.stdout.trimEnd().split("\0");
      if (ref.code === 0 && !ref.killed && remote && source?.startsWith("refs/") && destination?.startsWith("refs/")) {
        target = {
          key: JSON.stringify([root, status.branch, remote, source, destination]),
          root,
          remote,
          source,
          destination,
        };
      }
    }
    this.setTarget(target);
    this.snapshot = {
      ...status,
      kind: "repo",
      root,
      repo: basename(root),
      localStale: false,
      remoteState: status.upstream && !target ? "stale" : this.snapshot.remoteState,
    };
    this.changed();
    this.maybeFetch();
  }

  private setTarget(target: Upstream | null): void {
    if (this.target?.key === target?.key) return;
    this.fetchController?.abort();
    this.target = target;
    this.nextFetch = this.failures = 0;
    this.snapshot = { ...this.snapshot, remoteState: "cached" };
  }

  private maybeFetch(): void {
    const target = this.target;
    if (this.stopped || !target || this.fetchPromise || this.clock() < this.nextFetch) return;
    if (!this.fetchEnabled && target.remote !== ".") return;
    // A local upstream needs no network fetch and must never be rewritten.
    if (target.remote === ".") {
      this.snapshot = { ...this.snapshot, remoteState: "fresh" };
      this.nextFetch = this.clock() + FETCH_INTERVAL_MS;
      this.changed();
      return;
    }
    // Unusual refspecs must not cause this footer to rewrite local branches or tags.
    if (/^refs\/(heads|tags)\//.test(target.destination)) {
      this.snapshot = { ...this.snapshot, remoteState: "stale" };
      this.nextFetch = this.clock() + FETCH_INTERVAL_MS;
      this.changed();
      return;
    }
    this.fetchController = new AbortController();
    const signal = this.fetchController.signal;
    this.snapshot = { ...this.snapshot, remoteState: this.failures ? "stale" : "fetching" };
    this.changed();
    this.fetchPromise = this.fetchUpstream(target, signal).finally(() => {
      this.fetchPromise = null;
      this.fetchController = null;
      if (!this.stopped) {
        // Schedule after a possibly ongoing local refresh has completed.
        void (this.refreshPromise ?? Promise.resolve()).then(() => this.refresh(true));
      }
    });
  }

  private async fetchUpstream(target: Upstream, signal: AbortSignal): Promise<void> {
    let ok = false;
    try {
      const result = await this.runner(target.root, fetchArgs(target), signal, FETCH_TIMEOUT_MS);
      ok = result.code === 0 && !result.killed;
    } catch {
      // Preserve cached comparison on failure.
    }
    if (this.stopped || signal.aborted || this.target?.key !== target.key) return;
    this.failures = ok ? 0 : this.failures + 1;
    this.nextFetch = this.clock() + (ok ? FETCH_INTERVAL_MS : fetchBackoff(this.failures));
    this.snapshot = { ...this.snapshot, remoteState: ok ? "fresh" : "stale" };
    this.changed();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller.abort();
    this.fetchController?.abort();
    this.disposePromise = Promise.allSettled([this.refreshPromise, this.fetchPromise]).then(() => {});
    return this.disposePromise;
  }
}
