import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitSnapshot } from "./git.ts";
import type { TaskSnapshot, UsageTotals } from "./metrics.ts";

export type Tone = "text" | "dim" | "separator" | "blue" | "lavender" | "green" | "gold" | "amber" | "red" | "track";
export interface Segment {
  text: string;
  tone: Tone;
  pulse?: boolean;
}
export type Parts = Segment[];
export interface Pair {
  left: Parts;
  right: Parts;
}
interface Variant {
  parts: Parts;
  width: number;
  emergency: boolean;
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
  meter?: "cells" | "line";
}

const MIN_PAIR_GAP = 4;
const taskStyles = {
  working: ["●", "blue"],
  done: ["✓", "green"],
  aborted: ["■", "amber"],
  error: ["×", "red"],
  idle: ["○", "dim"],
} as const satisfies Record<TaskSnapshot["state"], readonly [string, Tone]>;

// Approved prototype palette. Background stays owned by the terminal/pi theme.
const palettes = {
  dark: {
    text: "#e5e8ee",
    dim: "#8993a2",
    separator: "#747e8b",
    blue: "#98bce5",
    lavender: "#c2abe7",
    green: "#9ac9b3",
    gold: "#e6c891",
    amber: "#e3b574",
    red: "#e68f91",
    track: "#444d5a",
  },
  light: {
    text: "#293445",
    dim: "#637286",
    separator: "#7c899a",
    blue: "#376ba2",
    lavender: "#77549b",
    green: "#34715c",
    gold: "#876322",
    amber: "#996019",
    red: "#b2434e",
    track: "#c3ceda",
  },
};
const colors = Object.fromEntries(
  Object.entries(palettes).map(([appearance, palette]) => [
    appearance,
    Object.fromEntries(Object.entries(palette).map(([key, hex]) => [key, parseColor(hex)])),
  ]),
) as Record<"dark" | "light", Record<Tone, ReturnType<typeof parseColor>>>;

/** Untrusted repo/model/status names must not inject terminal escapes or extra rows. */
export const cleanText = (text: string): string =>
  stripVTControlCharacters(text)
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export const plain = (parts: Parts): string => parts.map((part) => part.text).join("");
const widthOf = (parts: Parts): number => visibleWidth(plain(parts));
const normalizeColumns = (columns: number): number => (Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0);
const segment = (text: string, tone: Tone = "text"): Segment => ({ text, tone });
const variant = (parts: Parts, emergency = false): Variant => ({ parts, width: widthOf(parts), emergency });
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

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const parts = [seconds % 60];
  if (seconds >= 60) parts.unshift(Math.floor(seconds / 60) % 60);
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export const contextTone = (percent: number): Tone => (percent >= 90 ? "red" : percent >= 70 ? "amber" : "blue");

function gitVariants(data: GitSnapshot): Variants {
  const repo = cleanText(data.repo);
  const branch = cleanText(data.branch);
  const identity = (short = false): Parts =>
    joinGroups([
      [segment(short ? truncateToWidth(repo, 9, "…") : repo)],
      ...(data.kind === "repo" ? [[segment(short ? truncateToWidth(branch, 14, "…") : branch, "lavender")]] : []),
    ]);
  if (data.kind !== "repo") {
    const label =
      data.kind === "loading" ? "checking Git…" : data.kind === "not-repo" ? "not a Git repo" : "Git unavailable";
    return [
      variant(joinGroups([identity(), [segment(label, data.kind === "error" ? "amber" : "dim")]])),
      variant([segment(label, "dim")]),
    ];
  }

  const dirty: Parts[] = [];
  if (data.conflicts) dirty.push(metric(data.conflicts, "conflicts", "red"));
  if (data.modified) dirty.push(metric(data.modified, "modified", "amber"));
  if (data.staged) dirty.push(metric(data.staged, "staged", "green"));
  if (data.untracked) dirty.push(metric(data.untracked, "untracked", "dim"));
  if (!dirty.length) dirty.push([segment("clean", "green")]);
  const compactDirty = data.conflicts
    ? metric(data.conflicts, "conflicts", "red")
    : data.dirtyFiles
      ? metric(data.dirtyFiles, "dirty", "amber")
      : [segment("clean", "green")];

  const difference: Parts[] = [];
  if (!data.upstream) difference.push([segment("no upstream", "dim")]);
  else if (data.ahead === null || data.behind === null) difference.push([segment("upstream unknown", "amber")]);
  else {
    if (data.ahead) difference.push(metric(data.ahead, "ahead", "green"));
    if (data.behind) difference.push(metric(data.behind, "behind", "amber"));
    if (!data.ahead && !data.behind) difference.push([segment("synced", "green")]);
  }
  const remote: Parts =
    !data.upstream || data.remoteState === "fresh"
      ? []
      : [segment(data.remoteState === "stale" ? "remote stale" : "remote cached", "amber")];
  const local: Parts = data.localStale ? [segment("status stale", "amber")] : [];
  const warnings = joinGroups([local, data.conflicts ? compactDirty : [], remote], " · ");
  const priority = warnings.length ? warnings : compactDirty;
  const comparison = joinGroups([remote, ...difference], " · ");
  const noUpstream = data.upstream ? [] : difference;
  const fullIdentity = identity();
  const shortIdentity = identity(true);
  return [
    variant(joinGroups([fullIdentity, local, joinGroups(dirty, " · "), comparison])),
    variant(joinGroups([fullIdentity, local, compactDirty, comparison])),
    variant(joinGroups([shortIdentity, local, compactDirty, comparison])),
    variant(joinGroups([shortIdentity, priority, ...noUpstream]), true),
    // At tiny widths, preserve warnings before spending columns on a long repository name.
    variant(joinGroups([priority, ...noUpstream, [segment(truncateToWidth(branch, 10, "…"), "lavender")]]), true),
    variant(priority, true),
  ];
}

function modelVariants(data: FooterData): Variants {
  const provider = cleanText(data.provider);
  const prefix = provider ? `${provider}/` : "";
  const model = cleanText(data.model || "no model");
  const short = model.replace(/^claude-/, "");
  const level = [segment(" · ", "separator"), segment(cleanText(data.thinking), "dim")];
  return [
    variant([segment(prefix + model, "dim"), ...level]),
    variant([segment(prefix + short, "dim"), ...level]),
    variant([segment(prefix + truncateToWidth(short, 22, "…"), "dim")]),
  ];
}

function usageVariants(data: FooterData): Variants {
  const { tokens, capacity } = data.context;
  const validCapacity = Number.isFinite(capacity) && capacity > 0;
  const known = tokens !== null && Number.isFinite(tokens) && tokens >= 0 && validCapacity;
  const percent = known ? (tokens / capacity) * 100 : 0;
  const tone = known ? contextTone(percent) : "dim";
  const context = (cells: number): Parts => {
    const filled = known ? Math.round((Math.max(0, Math.min(100, percent)) * cells) / 100) : 0;
    const glyph = data.meter === "line" ? "━" : "▰";
    return [
      segment(`${known ? formatNumber(tokens) : "?"}/${validCapacity ? formatNumber(capacity) : "?"}`, tone),
      segment(" "),
      segment(glyph.repeat(filled), tone),
      segment(glyph.repeat(cells - filled), "track"),
    ];
  };
  const io = [
    segment(`↑${formatNumber(data.usage.input)}`, "lavender"),
    segment(" · ", "separator"),
    segment(`↓${formatNumber(data.usage.output)}`, "lavender"),
  ];
  const cache = data.usage.cache === null ? [] : [segment(`cache ${Math.round(data.usage.cache)}%`, "green")];
  const cost = [segment(`$${data.usage.cost.toFixed(3)}`, "gold")];
  const fullSize = data.meter === "line" ? 12 : 8;
  const compactSize = data.meter === "line" ? 8 : 6;
  return [
    variant(joinGroups([context(fullSize), io, cache, cost])),
    variant(joinGroups([context(compactSize), io, cache, cost])),
    variant(joinGroups([context(compactSize), io, cost])),
    variant(joinGroups([context(compactSize), cost])),
    variant(joinGroups([context(4), cost])),
    variant(context(4)),
  ];
}

export function taskVariants(task: TaskSnapshot): Variants {
  const [icon, tone] = taskStyles[task.state];
  const status = [{ ...segment(icon, tone), pulse: task.state === "working" }, segment(` ${task.state}`, tone)];
  if (task.state === "idle") return [variant(status)];
  const time = [segment(task.elapsedMs === null ? "—" : formatDuration(task.elapsedMs))];
  const { speed } = task;
  const hasSpeed = speed !== null && Number.isFinite(speed) && (task.state === "working" || task.state === "done");
  const rate = [segment(hasSpeed ? `${Math.round(speed)} tok/s` : "—", hasSpeed ? "text" : "dim")];
  return [
    variant(joinGroups([status, joinGroups([time, rate], " · ")])),
    variant(joinGroups([status, time])),
    variant(status),
  ];
}

function clip(parts: Parts, columns: number): Parts {
  if (widthOf(parts) <= columns) return parts;
  let remaining = Math.max(0, columns - 1);
  const result: Parts = [];
  for (const part of parts) {
    const text = truncateToWidth(part.text, remaining, "");
    const width = visibleWidth(text);
    if (text) result.push({ ...part, text });
    remaining -= width;
    if (width < visibleWidth(part.text)) break;
  }
  if (columns > 0) result.push(segment("…", "dim"));
  return result;
}

function fitPair(leftOptions: Variants, rightOptions: Variants, columns: number): Pair {
  for (const left of leftOptions) {
    if (left.emergency) continue;
    for (const right of rightOptions) {
      if (left.width + right.width + MIN_PAIR_GAP <= columns) return { left: left.parts, right: right.parts };
    }
  }
  let fallback = leftOptions[0];
  for (const left of leftOptions) {
    if (left.width <= columns) return { left: left.parts, right: [] };
    fallback = left;
  }
  return { left: clip(fallback.parts, columns), right: [] };
}

export function layoutFooter(data: FooterData, columns: number): [Pair, Pair] {
  columns = normalizeColumns(columns);
  return [
    fitPair(gitVariants(data.git), modelVariants(data), columns),
    fitPair(usageVariants(data), taskVariants(data.task), columns),
  ];
}

export function renderFooter(data: FooterData, columns: number, theme: Theme, pulse = false): string[] {
  columns = normalizeColumns(columns);
  const palette = colors[theme.appearance];
  const paint = (parts: Parts) =>
    parts.map((part) => theme.style(part.text, { fg: palette[part.tone], dim: Boolean(part.pulse && pulse) })).join("");
  return layoutFooter(data, columns).map(({ left, right }) => {
    const gap = right.length ? " ".repeat(Math.max(0, columns - widthOf(left) - widthOf(right))) : "";
    return truncateToWidth(paint(left) + gap + paint(right), columns, "");
  });
}
