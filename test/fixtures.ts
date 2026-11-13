import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyGit } from "../src/git.ts";
import type { FooterData } from "../src/render.ts";

export const usage = (patch: Partial<Usage> = {}): Usage => ({
  input: 200,
  output: 100,
  cacheRead: 800,
  cacheWrite: 0,
  totalTokens: 1100,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.04 },
  ...patch,
});
export const assistant = (patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  provider: "openai",
  model: "gpt-test",
  api: "openai-responses",
  timestamp: 0,
  usage: usage(),
  stopReason: "stop",
  ...patch,
});
let sequence = 0;
export const entry = (data: Record<string, unknown>): SessionEntry =>
  ({
    id: String(++sequence),
    parentId: null,
    timestamp: new Date(0).toISOString(),
    ...data,
  }) as SessionEntry;
export const example = (): FooterData => ({
  git: {
    ...emptyGit("/project/atlas"),
    kind: "repo",
    root: "/project/atlas",
    repo: "atlas",
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
    modified: 3,
    staged: 1,
    untracked: 2,
    dirtyFiles: 5,
    remoteState: "fresh",
  },
  usage: { input: 217000, output: 12000, cache: 92, cost: 0.05 },
  context: { tokens: 182000, capacity: 500000 },
  provider: "openai-codex",
  model: "gpt-5.4",
  thinking: "high",
  task: { state: "working", elapsedMs: 12000, speed: 42 },
});
