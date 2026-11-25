import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitSnapshot } from "./git.ts";
import type { TaskSnapshot, UsageTotals } from "./metrics.ts";

type Tone =
  | "text"
  | "dim"
  | "separator"
  | "blue"
  | "lavender"
  | "green"
  | "amber"
  | "red"
  | "track"
  | `thinking-${"minimal" | "low" | "medium" | "high" | "xhigh" | "max"}`;
interface Segment {
  text: string;
  tone: Tone;
  pulse?: boolean;
}
type Parts = Segment[];
interface Pair {
  left: Parts;
  right: Parts;
}
interface Variant {
  parts: Parts;
  width: number;
}
type Variants = [Variant, ...Variant[]];

export interface FooterData {
  git: GitSnapshot;
  usage: UsageTotals;
  context: { tokens: number | null; capacity: number };
  provider: string;
  model: string;
  thinking: string;
  task: TaskSnapshot;
}

const MIN_PAIR_GAP = 4;
const taskStyles = {
  working: ["●", "blue"],
  done: ["✓", "green"],
  aborted: ["■", "amber"],
  error: ["×", "red"],
  idle: ["○", "dim"],
} as const satisfies Record<TaskSnapshot["state"], readonly [string, Tone]>;

const thinkingTones = new Map<string, Tone>([
  ["minimal", "thinking-minimal"],
  ["low", "thinking-low"],
  ["medium", "thinking-medium"],
  ["high", "thinking-high"],
  ["xhigh", "thinking-xhigh"],
  ["max", "thinking-max"],
]);

// Blue encodes capacity, purple computation; green/amber/red encode status.
// Background stays owned by the terminal/pi theme.
const palettes = {
  dark: {
    text: "#e5e8ee",
    dim: "#9aa6b5",
    separator: "#667181",
    blue: "#98bce5",
    lavender: "#c2abe7",
    green: "#9ac9b3",
    amber: "#e3b574",
    red: "#e68f91",
    track: "#444d5a",
    "thinking-minimal": "#aaa4b3",
    "thinking-low": "#b4a6c7",
    "thinking-medium": "#bba5da",
    "thinking-high": "#c5a3ed",
    "thinking-xhigh": "#d0a6ff",
    "thinking-max": "#e0baff",
  },
  light: {
    text: "#293445",
    dim: "#5e6c7c",
    separator: "#7c899a",
    blue: "#376ba2",
    lavender: "#77549b",
    green: "#34715c",
    amber: "#996019",
    red: "#b2434e",
    track: "#c3ceda",
    "thinking-minimal": "#706779",
    "thinking-low": "#705c86",
    "thinking-medium": "#704e99",
    "thinking-high": "#6d3dad",
    "thinking-xhigh": "#6627bf",
    "thinking-max": "#5912cc",
  },
} satisfies Record<"dark" | "light", Record<Tone, string>>;
const colors = Object.fromEntries(
  Object.entries(palettes).map(([appearance, palette]) => [
    appearance,
    Object.fromEntries(Object.entries(palette).map(([key, hex]) => [key, parseColor(hex)])),
  ]),
) as Record<"dark" | "light", Record<Tone, ReturnType<typeof parseColor>>>;

/** Untrusted repo/model/status names must not inject terminal escapes or extra rows. */
const cleanText = (text: string): string =>
  stripVTControlCharacters(text)
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
// pi-tui may insert ANSI resets around the ellipsis. Label segments must stay plain
// until paint(), otherwise those resets override our colors.
const clipText = (text: string, columns: number, ellipsis = "…"): string =>
  stripVTControlCharacters(truncateToWidth(text, columns, ellipsis));
const widthOf = (parts: Parts): number => visibleWidth(parts.map((part) => part.text).join(""));
const normalizeColumns = (columns: number): number => (Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0);
const segment = (text: string, tone: Tone = "text"): Segment => ({ text, tone });
const variant = (parts: Parts): Variant => ({ parts, width: widthOf(parts) });
const metric = (count: number, label: string, tone: Tone): Parts => [segment(`${count} ${label}`, tone)];

function joinGroups(groups: Parts[], separator = " │ "): Parts {
  return groups
    .filter((group) => group.length)
    .flatMap((group, index) => (index ? [segment(separator, "separator"), ...group] : group));
}

export function formatNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${Number((value / 1000).toFixed(1))}k`;
  return `${Number((value / 1_000_000).toFixed(1))}M`;
}

export function formatDuration(ms: number, style: "clock" | "units" = "clock"): string {
  const seconds = Math.floor(ms / 1000);
  const parts: [number, string][] = [[seconds % 60, "s"]];
  if (seconds >= 60) parts.unshift([Math.floor(seconds / 60) % 60, "m"]);
  if (seconds >= 3600) parts.unshift([Math.floor(seconds / 3600), "h"]);
  return parts
    .map(([value, unit]) => String(value).padStart(2, "0") + (style === "units" ? unit : ""))
    .join(style === "units" ? "" : ":");
}

const contextTone = (percent: number): Tone => (percent >= 90 ? "red" : percent >= 70 ? "amber" : "blue");

function gitVariants(data: GitSnapshot): Variants {
  const repo = cleanText(data.repo);
  const branch = cleanText(data.branch);
  const identity = (short = false): Parts =>
    joinGroups([
      [segment(short ? clipText(repo, 9) : repo)],
      ...(data.kind === "repo" ? [[segment(short ? clipText(branch, 14) : branch)]] : []),
    ]);
  if (data.kind !== "repo") {
    const label =
      data.kind === "loading" ? "checking Git…" : data.kind === "not-repo" ? "not a Git repo" : "Git unavailable";
    const tone = data.kind === "error" ? "amber" : "dim";
    return [
      variant(joinGroups([identity(), [segment(label, tone)]])),
      variant(data.kind === "error" ? [segment(label, tone)] : identity(true)),
    ];
  }

  const dirty: Parts[] = [];
  if (data.conflicts) dirty.push(metric(data.conflicts, "conflicts", "red"));
  if (data.modified) dirty.push(metric(data.modified, "modified", "amber"));
  if (data.staged) dirty.push(metric(data.staged, "staged", "green"));
  if (data.untracked) dirty.push(metric(data.untracked, "untracked", "amber"));
  if (!dirty.length) dirty.push([segment("clean", "dim")]);
  const compactDirty = data.conflicts
    ? metric(data.conflicts, "conflicts", "red")
    : data.dirtyFiles
      ? metric(data.dirtyFiles, "dirty", "amber")
      : [segment("clean", "dim")];

  const difference: Parts[] = [];
  if (!data.upstream) difference.push([segment("no upstream", "dim")]);
  else if (data.ahead === null || data.behind === null) difference.push([segment("upstream unknown", "amber")]);
  else {
    if (data.ahead) difference.push(metric(data.ahead, "ahead", "blue"));
    if (data.behind) difference.push(metric(data.behind, "behind", "amber"));
    if (!data.ahead && !data.behind) difference.push([segment("synced", "dim")]);
  }
  const remote: Parts =
    !data.upstream || data.remoteState === "fresh"
      ? []
      : [segment(data.remoteState === "stale" ? "remote stale" : "remote cached", "amber")];
  const local: Parts = data.localStale ? [segment("status stale", "amber")] : [];
  const warnings = joinGroups([data.conflicts ? compactDirty : [], local, remote], " · ");
  const summary = warnings.length ? warnings : data.dirtyFiles ? compactDirty : [];
  const shortBranch = [segment(clipText(branch, 14))];
  const warning = data.conflicts ? compactDirty : local.length ? local : remote;
  const comparison = joinGroups([remote, ...difference], " · ");
  const noUpstream = data.upstream ? [] : difference;
  const fullIdentity = identity();
  const shortIdentity = identity(true);
  return [
    variant(joinGroups([fullIdentity, local, joinGroups(dirty, " · "), comparison])),
    variant(joinGroups([fullIdentity, local, compactDirty, comparison])),
    variant(joinGroups([shortIdentity, local, compactDirty, comparison])),
    variant(joinGroups([shortIdentity, summary, ...noUpstream])),
    variant(joinGroups([shortBranch, summary])),
    variant(joinGroups([shortBranch, warning])),
    variant(warning.length ? warning : shortBranch),
  ];
}

function modelVariants(data: FooterData): [Variant, Variant, Variant] {
  const provider = cleanText(data.provider);
  const prefix = provider ? `[${provider}] ` : "";
  const model = cleanText(data.model || "no model");
  const thinking = cleanText(data.thinking);
  const level = [segment(" [", "dim"), segment(thinking, thinkingTones.get(thinking) ?? "dim"), segment("]", "dim")];
  const name = segment(model, model === "no model" ? "dim" : "text");
  return [variant([segment(prefix, "dim"), name, ...level]), variant([name, ...level]), variant([name])];
}

function usageVariants(data: FooterData): Variants {
  const { tokens, capacity } = data.context;
  const validCapacity = Number.isFinite(capacity) && capacity > 0;
  const known = tokens !== null && Number.isFinite(tokens) && tokens >= 0 && validCapacity;
  const percent = known ? (tokens / capacity) * 100 : 0;
  const tone = known ? contextTone(percent) : "dim";
  const context = (cells: number): Parts => {
    const filled = known ? Math.round((Math.max(0, Math.min(100, percent)) * cells) / 100) : 0;
    return [
      segment(known ? formatNumber(tokens) : "?", tone),
      segment("▰".repeat(filled), tone),
      segment("▰".repeat(cells - filled), "track"),
      segment(` ${validCapacity ? formatNumber(capacity) : "?"}`, "dim"),
      segment(` ${known ? Math.round(percent) : "?"}%`, tone),
    ];
  };
  const io = [
    segment(`↑${formatNumber(data.usage.input)}`, "lavender"),
    segment(" "),
    segment(`↓${formatNumber(data.usage.output)}`, "lavender"),
  ];
  const cache =
    data.usage.cache === null ? [] : [segment("cache ", "dim"), segment(`${Math.round(data.usage.cache)}%`)];
  const cost = [segment(`$${data.usage.cost.toFixed(3)}`)];
  return [
    variant(joinGroups([context(8), io, cache, cost])),
    variant(joinGroups([context(6), io, cache, cost])),
    variant(joinGroups([context(6), io, cost])),
    variant(joinGroups([context(6), io])),
    variant(context(6)),
    variant(context(4)),
    variant([segment(`${known ? Math.round(percent) : "?"}%`, tone)]),
  ];
}

function taskVariants(task: TaskSnapshot) {
  const [icon, tone] = taskStyles[task.state];
  const symbol = [{ ...segment(icon, tone), pulse: task.state === "working" }];
  const status = [...symbol, segment(` ${task.state}`, tone)];
  const iconOnly = variant(symbol);
  if (task.state === "idle") return { full: variant(status), compact: [iconOnly], minimum: [iconOnly], iconOnly };
  const time = [
    segment(
      task.elapsedMs === null ? "—" : formatDuration(task.elapsedMs, task.state === "working" ? "clock" : "units"),
      "dim",
    ),
  ];
  const { speed } = task;
  const hasSpeed = speed !== null && Number.isFinite(speed) && (task.state === "working" || task.state === "done");
  const rate = [segment(hasSpeed ? `${Math.round(speed)}tk/s` : "—", hasSpeed ? "lavender" : "dim")];
  const elapsed = variant(joinGroups([symbol, time], " "));
  const compact = [elapsed];
  if (task.state === "error" || task.state === "aborted") compact.unshift(variant(joinGroups([status, time])));
  else if (hasSpeed) compact.unshift(variant(joinGroups([symbol, time, rate], " ")));
  return {
    full: variant(joinGroups([status, joinGroups([time, rate], " ")])),
    compact,
    minimum: [elapsed, iconOnly],
    iconOnly,
  };
}

function clip(parts: Parts, columns: number): Parts {
  if (widthOf(parts) <= columns) return parts;
  let remaining = Math.max(0, columns - 1);
  const result: Parts = [];
  for (const part of parts) {
    const text = clipText(part.text, remaining, "");
    const width = visibleWidth(text);
    if (text) result.push({ ...part, text });
    remaining -= width;
    if (width < visibleWidth(part.text)) break;
  }
  if (columns > 0) result.push(segment("…", "dim"));
  return result;
}

function fitPair(leftOptions: Variant[], rightOptions: Variant[], columns: number): Pair | undefined {
  for (const right of rightOptions) {
    const left = leftOptions.find((option) => option.width + MIN_PAIR_GAP + right.width <= columns);
    if (left) return { left: left.parts, right: right.parts };
  }
  return undefined;
}

function identityRow(data: FooterData, columns: number): Pair {
  const git = gitVariants(data.git);
  const [full, thinking, name] = modelVariants(data);
  const essential = git[git.length - 1];
  // Provider is a wide-layout detail. Never bring it back just because Git got shorter.
  const pair = fitPair([git[0]], [full], columns) ?? fitPair(git, [thinking, name], columns);
  if (pair) return pair;

  const budget = columns - essential.width - MIN_PAIR_GAP;
  if (budget >= 8) return { left: essential.parts, right: clip(name.parts, budget) };
  if (data.git.conflicts || data.git.kind === "error" || data.git.localStale || data.git.remoteState === "stale") {
    return { left: clip(essential.parts, columns), right: [] };
  }
  return { left: [], right: clip(name.parts, columns) };
}

function activityRow(data: FooterData, columns: number): Pair {
  const usage = usageVariants(data);
  const task = taskVariants(data.task);
  const percent = usage[usage.length - 1];
  return (
    fitPair([usage[0]], [task.full], columns) ??
    fitPair(usage.slice(0, -1), task.compact, columns) ??
    fitPair([percent], task.minimum, columns) ?? { left: [], right: task.iconOnly.parts }
  );
}

export function renderFooter(data: FooterData, columns: number, theme: Theme, pulse = false): string[] {
  columns = normalizeColumns(columns);
  const palette = colors[theme.appearance];
  const paint = (parts: Parts) =>
    parts.map((part) => theme.style(part.text, { fg: palette[part.tone], dim: Boolean(part.pulse && pulse) })).join("");
  return [identityRow(data, columns), activityRow(data, columns)].map(({ left, right }) => {
    const gap = right.length ? " ".repeat(Math.max(0, columns - widthOf(left) - widthOf(right))) : "";
    return truncateToWidth(paint(left) + gap + paint(right), columns, "");
  });
}
