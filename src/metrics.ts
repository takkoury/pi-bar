import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
  input: number;
  output: number;
  cost: number;
  cache: number | null;
}

const isNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonNegative = (value: number | undefined): number => (isNonNegative(value) ? value : 0);

/** Same full-session accounting scope as pi: includes abandoned paths and auxiliary calls. */
export function sessionUsage(entries: readonly SessionEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cost: 0, cache: null };
  const add = (usage?: Usage) => {
    if (!usage) return;
    totals.input += nonNegative(usage.input);
    totals.output += nonNegative(usage.output);
    totals.cost += nonNegative(usage.cost?.total);
  };
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        add(message.usage);
        const prompt =
          nonNegative(message.usage.input) +
          nonNegative(message.usage.cacheRead) +
          nonNegative(message.usage.cacheWrite);
        totals.cache = prompt > 0 ? (nonNegative(message.usage.cacheRead) / prompt) * 100 : null;
      } else if (message.role === "toolResult") add(message.usage);
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      add(entry.usage);
    }
  }
  return totals;
}

export type TaskState = "idle" | "working" | "done" | "aborted" | "error";
export interface TaskSnapshot {
  state: TaskState;
  elapsedMs: number | null;
  speed: number | null;
}
export const TASK_ENTRY = "pi-bar:task:v1";

function parseTaskSnapshot(data: unknown): TaskSnapshot | undefined {
  if (!data || typeof data !== "object") return;
  const { state, elapsedMs, speed } = data as Record<string, unknown>;
  if (state !== "done" && state !== "aborted" && state !== "error") return;
  if (!isNonNegative(elapsedMs)) return;
  return {
    state,
    elapsedMs,
    speed: state === "done" && isNonNegative(speed) && speed > 0 ? speed : null,
  };
}

/** No estimates from text length; speed changes only when a response reports final usage. */
export class TaskTracker {
  private readonly clock: () => number;
  private startedAt: number | null = null;
  private requestStartedAt: number | null = null;
  private tokens = 0;
  private requestMs = 0;
  private latestSpeed: number | null = null;
  private lastStop: AssistantMessage["stopReason"] | null = null;
  private final: TaskSnapshot = { state: "idle", elapsedMs: null, speed: null };

  constructor(clock = () => performance.now()) {
    this.clock = clock;
  }

  get isWorking(): boolean {
    return this.startedAt !== null;
  }

  start(): void {
    // Retries, auto-compaction, steering and follow-ups form one task until settled.
    if (this.startedAt !== null) return;
    this.startedAt = this.clock();
    this.requestStartedAt = null;
    this.tokens = this.requestMs = 0;
    this.latestSpeed = null;
    this.lastStop = null;
  }

  requestStart(): void {
    this.start();
    this.requestStartedAt = this.clock();
  }

  response(message: AssistantMessage): void {
    if (this.startedAt === null) return;
    this.lastStop = message.stopReason;
    // Host timing covers the entire request (including network/prefill/reasoning), not tools.
    const ms = message.durationMs ?? (this.requestStartedAt === null ? null : this.clock() - this.requestStartedAt);
    this.requestStartedAt = null;
    const output = nonNegative(message.usage.output);
    if (ms !== null && Number.isFinite(ms) && ms > 0 && message.stopReason !== "deferred") {
      this.tokens += output;
      this.requestMs += ms;
      this.latestSpeed = output > 0 ? (output * 1000) / ms : null;
    } else this.latestSpeed = null;
  }

  /** Returns a record only for a newly settled task. */
  settle(aborted: boolean): TaskSnapshot | undefined {
    if (this.startedAt === null) return;
    const state = aborted || this.lastStop === "aborted" ? "aborted" : this.lastStop === "error" ? "error" : "done";
    this.final = {
      state,
      elapsedMs: Math.max(0, this.clock() - this.startedAt),
      speed: state === "done" && this.tokens > 0 && this.requestMs > 0 ? (this.tokens * 1000) / this.requestMs : null,
    };
    this.startedAt = this.requestStartedAt = null;
    return this.snapshot();
  }

  snapshot(): TaskSnapshot {
    return this.startedAt === null
      ? { ...this.final }
      : {
          state: "working",
          elapsedMs: Math.max(0, this.clock() - this.startedAt),
          speed: this.latestSpeed,
        };
  }

  restore(branch: readonly SessionEntry[]): void {
    this.startedAt = this.requestStartedAt = null;
    this.final = { state: "idle", elapsedMs: null, speed: null };
    // Never attach an older task's timing to a newer, interrupted/unmeasured task.
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) return;
      if (entry.type !== "custom" || entry.customType !== TASK_ENTRY) continue;
      this.final = parseTaskSnapshot(entry.data) ?? this.final;
      return;
    }
  }
}
