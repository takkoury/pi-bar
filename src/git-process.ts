import { spawn } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

export type GitRunner = (cwd: string, args: string[], signal: AbortSignal, timeoutMs?: number) => Promise<GitResult>;

const LOCAL_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Bounded, shell-free commands. Terminate the process tree, not just git's parent process. */
export const runGit: GitRunner = (cwd, args, signal, timeoutMs = LOCAL_TIMEOUT_MS) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ code: -1, stdout: "", stderr: "cancelled", killed: true });
      return;
    }

    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GCM_GUI_PROMPT: "0",
        GIT_ASKPASS: "false",
        SSH_ASKPASS: "false",
        SSH_ASKPASS_REQUIRE: "never",
        // Require preconfigured noninteractive SSH authentication and known hosts.
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10",
        GIT_SSH_VARIANT: "ssh",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let killed = false;
    let finished = false;

    const stop = () => {
      if (killed || finished) return;
      killed = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          child.kill("SIGKILL");
        });
        killer.unref();
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    const finish = (code: number, error = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({
        code: killed ? -1 : code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error || Buffer.concat(stderr).toString("utf8"),
        killed,
      });
    };
    signal.addEventListener("abort", stop, { once: true });
    // Close the small race between the initial check and listener registration.
    if (signal.aborted) stop();

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(-1, error.message));
    child.on("close", (code) => finish(code ?? -1));
  });
