import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, styleText, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatNumber, renderFooter, type FooterData } from "../src/render.ts";
import { example } from "./fixtures.ts";

const theme = (appearance: "dark" | "light") =>
  ({
    appearance,
    style: (text: string, options: Parameters<Theme["style"]>[1]) =>
      styleText(text, options as Parameters<typeof styleText>[1], "truecolor"),
  }) as Theme;

const splitRow = (row: string) => stripVTControlCharacters(row).split(/ {4,}/);
const textRows = (data: FooterData, columns = 160) => renderFooter(data, columns, theme("dark")).map(splitRow);
const taskText = (task: FooterData["task"]) => textRows({ ...example(), task })[1][1];

const palettes = {
  dark: {
    background: "#1c1e22",
    text: "#e5e8ee",
    dim: "#9aa6b5",
    separator: "#667181",
    track: "#444d5a",
    blue: "#98bce5",
    lavender: "#c2abe7",
    green: "#9ac9b3",
    amber: "#e3b574",
    red: "#e68f91",
  },
  light: {
    background: "#f9fafb",
    text: "#293445",
    dim: "#5e6c7c",
    separator: "#7c899a",
    track: "#c3ceda",
    blue: "#376ba2",
    lavender: "#77549b",
    green: "#34715c",
    amber: "#996019",
    red: "#b2434e",
  },
};
const expectColor = (row: string, text: string, hex: string) => {
  assert.ok(
    row.includes(styleText(text, { fg: parseColor(hex), dim: false }, "truecolor")),
    `${JSON.stringify(text)}: ${hex}`,
  );
};
const luminance = (hex: string) => {
  const linear = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};
const contrast = (foreground: string, background: string) => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("wide layout uses consistent separators, provider prefix and compact metrics", () => {
  const data = example();
  assert.deepEqual(textRows(data), [
    ["atlas │ main │ 3 modified · 1 staged · 2 untracked │ 2 ahead", "[openai-codex] gpt-5.4 [high]"],
    ["182k▰▰▰▰▰▰▰▰ 500k 36% │ ↑217k ↓12k │ cache 92% │ $0.050", "● working │ 12 42tk/s"],
  ]);
  assert.equal(taskText({ state: "done", elapsedMs: 48000, speed: 56 }), "✓ done │ 48s 56tk/s");
});

test("context, model and token totals preserve literal brackets and single spaces", () => {
  const data = example();
  data.context = { tokens: 15000, capacity: 272000 };
  data.provider = "openai";
  data.model = "gpt-6-astra";
  data.thinking = "low";
  data.usage.input = 129700;
  data.usage.output = 35500;
  const [top, bottom] = textRows(data);
  assert.equal(top[1], "[openai] gpt-6-astra [low]");
  // Percentage is calculated from actual usage, not the rounded labels.
  assert.equal(bottom[0], "15k▰▰▰▰▰▰▰▰ 272k 6% │ ↑129.7k ↓35.5k │ cache 92% │ $0.050");
  data.context.tokens = 54400;
  assert.match(textRows(data)[1][0], /^54\.4k▰{8} 272k 20% │ /);
});

test("all widths, states and palettes render exactly two bounded rows", () => {
  for (const state of ["working", "done", "aborted", "error", "idle"] as const)
    for (const appearance of ["dark", "light"] as const)
      for (const columns of [0, 1, 2, 4, 8, 15, 20, 30, 40, 60, 80, 100, 120, 160, 240]) {
        const data = example();
        data.task.state = state;
        data.task.elapsedMs = 5415000;
        data.git.repo = "仓库-🧪-e\u0301-with-a-long-name";
        data.git.branch = "feature/very-long-branch-for-terminal-width-check";
        data.model = "claude-opus-4-6-with-an-extra-long-model-name";
        const rows = renderFooter(data, columns, theme(appearance), true);
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.ok(visibleWidth(row) <= columns);
          assert.doesNotMatch(row, /[\r\n]/);
          const parts = splitRow(row);
          assert.ok(parts.length <= 2);
          for (const part of parts) assert.doesNotMatch(part.trimStart(), / {2}/);
          if (parts.length === 2) assert.equal(visibleWidth(row), columns);
        }
      }
});

test("Git warnings and unique dirty count are protected as space shrinks", () => {
  const data = example();
  data.git.conflicts = 2;
  data.git.remoteState = "stale";
  assert.match(textRows(data, 80)[0][0], /2 conflicts/);
  assert.match(textRows(data, 80)[0][0], /remote stale/);
  assert.match(textRows(data, 30)[0][0], /2 conflicts/);
  data.git.conflicts = 0;
  data.git.remoteState = "fresh";
  assert.match(textRows(data, 50)[0][0], /5 dirty/);
  data.git.upstream = null;
  data.git.ahead = data.git.behind = null;
  const noUpstream = textRows(data, 120)[0][0];
  assert.match(noUpstream, /no upstream/);
  assert.doesNotMatch(noUpstream, /synced/);
  data.git.upstream = "origin/missing";
  assert.match(textRows(data, 120)[0][0], /upstream unknown/);
});

test("no terminal control injection through repo/provider/model/thinking labels", () => {
  const data = example();
  data.git.repo = "evil\x1b[2J\u202e\r\nrepo";
  data.provider = "\x1b[31mprovider\x1b[0m\nname";
  data.model = "\x1b]0;evil title\x07model\tname";
  data.thinking = "\x1b[31mhigh\x1b[0m\n";
  const lines = renderFooter(data, 160, theme("dark")).map(stripVTControlCharacters);
  assert.ok(lines[0].includes("evil repo"));
  assert.ok(lines[0].includes("[provider name] "));
  assert.ok(lines[0].includes("model name [high]"));
  assert.ok(!lines.some((line) => /[\n\t\x1b]/.test(line)));
  assert.ok(!lines.some((line) => line.includes("\u202e")));
});

test("shrinking width drops provider, then thinking, before clipping the model", () => {
  const data = example();
  data.model = "claude-opus-4-6-with-an-extra-long-model-name";
  const compact = `${data.model} [high]`;
  assert.equal(textRows(data, 160)[0][1], `[openai-codex] ${compact}`);
  assert.equal(textRows(data, 80)[0][1], compact);
  assert.equal(textRows(data, 55)[0][1], data.model);
  assert.match(textRows(data, 40)[0][1], /^claude-opus-4-6.*…$/);

  data.model = "gpt-5.4";
  for (const width of [40, 60]) {
    const [git, model] = textRows(data, width)[0];
    assert.match(git, /main/);
    assert.equal(model, "gpt-5.4 [high]");
  }
  data.git.conflicts = 2;
  assert.deepEqual(textRows(data, 25)[0], ["2 conflicts", data.model]);
  assert.match(textRows(data, 12)[0][0], /2 conflicts/);
});

test("compact task states keep the icon and time before dropping to just the icon", () => {
  const data = example();
  data.task = { state: "working", elapsedMs: 133000, speed: 70 };
  for (const [width, label] of [
    [160, "● working │ 02:13 70tk/s"],
    [60, "● 02:13 70tk/s"],
    [30, "● 02:13"],
    [12, "●"],
  ] as const) {
    const [usage, task] = textRows(data, width)[1];
    assert.match(usage, /36%/);
    assert.equal(task, label);
  }
  data.task.state = "done";
  assert.equal(textRows(data, 30)[1][1], "✓ 02m13s");
  for (const [state, icon] of [
    ["error", "×"],
    ["aborted", "■"],
  ] as const) {
    data.task.state = state;
    assert.equal(textRows(data, 40)[1][1], `${icon} ${state} │ 02m13s`);
    assert.equal(textRows(data, 12)[1][1], icon);
  }
  data.task.state = "idle";
  data.context.tokens = null;
  assert.deepEqual(textRows(data, 12)[1], ["?%", "○"]);
});

test("Cells has proportional fill and shrinks through eight, six and four cells", () => {
  const sizes = new Set<number>();
  for (const columns of [20, 25, 30, 40, 60, 80, 120, 160]) {
    for (const tokens of [0, 250000, 500000, 600000, null]) {
      const data = example();
      data.context.tokens = tokens;
      const row = renderFooter(data, columns, theme("dark"))[1];
      const size = stripVTControlCharacters(row).match(/▰+/)?.[0].length ?? 0;
      if (!size) {
        assert.equal(splitRow(row)[0], `${tokens === null ? "?" : Math.round(tokens / 5000)}%`);
        continue;
      }
      assert.ok([8, 6, 4].includes(size));
      if (columns === 160) assert.equal(size, 8);
      sizes.add(size);
      const filled = tokens === null ? 0 : Math.round(Math.min(tokens / 500000, 1) * size);
      if (tokens !== null && filled) {
        expectColor(row, "▰".repeat(filled), tokens >= 450000 ? palettes.dark.red : palettes.dark.blue);
      }
      if (filled < size) expectColor(row, "▰".repeat(size - filled), palettes.dark.track);
    }
  }
  assert.deepEqual([...sizes].sort(), [4, 6, 8]);
});

test("invalid terminal widths render empty rows rather than throwing", () => {
  for (const columns of [NaN, Infinity, -Infinity, -1]) {
    assert.deepEqual(renderFooter(example(), columns, theme("dark")), ["", ""]);
  }
  const rows = renderFooter(example(), 60.9, theme("light"));
  assert.ok(rows.every((row) => visibleWidth(row) <= 60));
});

test("invalid context values are displayed as unknown", () => {
  for (const tokens of [NaN, Infinity, -1]) {
    const data = example();
    data.context.tokens = tokens;
    assert.match(textRows(data)[1][0], /^\?▰{8} 500k \?% │ /);
  }
  for (const capacity of [NaN, Infinity, -1, 0]) {
    const data = example();
    data.context.capacity = capacity;
    assert.match(textRows(data)[1][0], /^\?▰{8} \? \?% │ /);
  }
});

test("stopped task metrics use unit suffixes and one space before compact throughput", () => {
  for (const [elapsedMs, clock, units] of [
    [5000, "05", "05s"],
    [30000, "30", "30s"],
    [133000, "02:13", "02m13s"],
    [324000, "05:24", "05m24s"],
    [5415000, "01:30:15", "01h30m15s"],
  ] as const) {
    assert.equal(taskText({ state: "working", elapsedMs, speed: 70 }), `● working │ ${clock} 70tk/s`);
    assert.equal(taskText({ state: "done", elapsedMs, speed: 105 }), `✓ done │ ${units} 105tk/s`);
    assert.equal(taskText({ state: "aborted", elapsedMs, speed: 105 }), `■ aborted │ ${units} —`);
    assert.equal(taskText({ state: "error", elapsedMs, speed: 105 }), `× error │ ${units} —`);
  }
  assert.equal(taskText({ state: "done", elapsedMs: null, speed: null }), "✓ done │ — —");
  assert.equal(taskText({ state: "idle", elapsedMs: null, speed: null }), "○ idle");
});

test("task time and throughput have distinct colors in both themes; unavailable rates stay dim", () => {
  for (const [appearance, timeColor, speedColor] of [
    ["dark", "#9aa6b5", "#c2abe7"],
    ["light", "#5e6c7c", "#77549b"],
  ] as const) {
    const palette = theme(appearance);
    for (const state of ["working", "done", "aborted", "error"] as const) {
      for (const speed of [null, 0, 70]) {
        const data = example();
        data.task = { state, elapsedMs: 324000, speed };
        const row = renderFooter(data, 160, palette)[1];
        const time = state === "working" ? "05:24" : "05m24s";
        const hasSpeed = speed !== null && (state === "working" || state === "done");
        const rate = hasSpeed ? `${speed}tk/s` : "—";
        assert.ok(row.includes(palette.style(time, { fg: parseColor(timeColor), dim: false })));
        assert.ok(row.includes(palette.style(rate, { fg: parseColor(hasSpeed ? speedColor : timeColor), dim: false })));
      }
    }
  }
});

test("Git identities stay neutral while actionable states retain semantic colors at all sizes", () => {
  for (const appearance of ["dark", "light"] as const) {
    const palette = palettes[appearance];
    const data = example();
    data.git.behind = 1;
    let row = renderFooter(data, 240, theme(appearance))[0];
    for (const [text, tone] of [
      ["atlas", "text"],
      ["main", "text"],
      [" │ ", "separator"],
      [" · ", "separator"],
      ["3 modified", "amber"],
      ["1 staged", "green"],
      ["2 untracked", "amber"],
      ["2 ahead", "blue"],
      ["1 behind", "amber"],
    ] as const)
      expectColor(row, text, palette[tone]);

    data.git.conflicts = 2;
    data.git.localStale = true;
    data.git.remoteState = "stale";
    row = renderFooter(data, 240, theme(appearance))[0];
    expectColor(row, "2 conflicts", palette.red);
    expectColor(row, "status stale", palette.amber);
    expectColor(row, "remote stale", palette.amber);
    for (const columns of [30, 60, 80, 160]) {
      const row = renderFooter(data, columns, theme(appearance))[0];
      const [left] = splitRow(row);
      for (const [label, tone] of [
        ["main", "text"],
        ["2 conflicts", "red"],
        ["status stale", "amber"],
        ["remote stale", "amber"],
      ] as const) {
        if (left.includes(label)) expectColor(row, label, palette[tone]);
      }
    }

    Object.assign(data.git, {
      conflicts: 0,
      modified: 0,
      staged: 0,
      untracked: 0,
      dirtyFiles: 0,
      ahead: 0,
      behind: 0,
      localStale: false,
      remoteState: "fresh",
    });
    row = renderFooter(data, 160, theme(appearance))[0];
    expectColor(row, "clean", palette.dim);
    expectColor(row, "synced", palette.dim);
    data.git.kind = "error";
    for (const columns of [15, 160]) {
      expectColor(renderFooter(data, columns, theme(appearance))[0], "Git unavailable", palette.amber);
    }
  }
});

test("capacity limits and ordinary metrics stay neutral while context usage follows thresholds", () => {
  for (const appearance of ["dark", "light"] as const) {
    const palette = palettes[appearance];
    for (const key of ["text", "dim", "blue", "lavender", "green", "amber", "red"] as const) {
      assert.ok(contrast(palette[key], palette.background) >= 4.5, `${appearance}: ${key}`);
    }
    for (const percent of [0, 69.9, 70, 89.9, 90, 110, null]) {
      const data = example();
      data.context.tokens = percent === null ? null : percent * 5000;
      const tone = percent === null ? "dim" : percent >= 90 ? "red" : percent >= 70 ? "amber" : "blue";
      const row = renderFooter(data, 160, theme(appearance))[1];
      const tokens = percent === null ? "?" : formatNumber(percent * 5000);
      const usage = percent === null ? "?" : Math.round(percent);
      assert.ok(splitRow(row)[0].startsWith(`${tokens}▰▰▰▰▰▰▰▰ 500k ${usage}% │ `));
      expectColor(row, tokens, palette[tone]);
      expectColor(row, " 500k", palette.dim);
      expectColor(row, ` ${usage}%`, palette[tone]);
      expectColor(row, "↑217k", palette.lavender);
      expectColor(row, "↓12k", palette.lavender);
      expectColor(row, "cache ", palette.dim);
      expectColor(row, "92%", palette.text);
      expectColor(row, "$0.050", palette.text);
    }
  }
});

test("thinking levels use the approved progressive purple ramp with neutral brackets in both themes", () => {
  const levels = [
    ["off", "#9aa6b5", "#5e6c7c"],
    ["minimal", "#aaa4b3", "#706779"],
    ["low", "#b4a6c7", "#705c86"],
    ["medium", "#bba5da", "#704e99"],
    ["high", "#c5a3ed", "#6d3dad"],
    ["xhigh", "#d0a6ff", "#6627bf"],
    ["max", "#e0baff", "#5912cc"],
  ] as const;
  for (const appearance of ["dark", "light"] as const) {
    const palette = palettes[appearance];
    const data = example();
    data.provider = "anthropic";
    data.model = "claude-opus-4-6-with-an-extra-long-model-name";
    let previousContrast = 0;
    for (const [level, dark, light] of levels) {
      const hex = appearance === "dark" ? dark : light;
      const ratio = contrast(hex, palette.background);
      assert.ok(ratio >= 4.5 && ratio > previousContrast, `${appearance}: ${level}`);
      previousContrast = ratio;
      data.thinking = level;
      for (const columns of [80, 100, 160, 240]) {
        const row = renderFooter(data, columns, theme(appearance))[0];
        const label = splitRow(row)[1];
        assert.ok(label);
        if (label.startsWith("[anthropic] ")) expectColor(row, "[anthropic] ", palette.dim);
        expectColor(row, data.model, palette.text);
        expectColor(row, " [", palette.dim);
        expectColor(row, level, hex);
        expectColor(row, "]", palette.dim);
        assert.equal(row, renderFooter(data, columns, theme(appearance), true)[0]);
        assert.ok(label.endsWith(` [${level}]`));
        assert.ok(visibleWidth(row) <= columns);
      }
    }
    for (const level of ["unknown", "constructor", "__proto__", "toString"]) {
      data.thinking = level;
      expectColor(renderFooter(data, 240, theme(appearance))[0], level, palette.dim);
    }
    data.provider = "";
    data.model = "";
    expectColor(renderFooter(data, 160, theme(appearance))[0], "no model", palette.dim);
  }
});

test("number formatting uses compact, stable units", () => {
  for (const [value, expected] of [
    [0, "0"],
    [999, "999"],
    [1200, "1.2k"],
    [182000, "182k"],
    [1500000, "1.5M"],
  ] as const) {
    assert.equal(formatNumber(value), expected);
  }
});

test("duration uses zero-padded clock fields and omits only unused leading fields", () => {
  for (const [ms, expected] of [
    [0, "00"],
    [999, "00"],
    [1000, "01"],
    [9000, "09"],
    [59000, "59"],
    [59999, "59"],
    [60000, "01:00"],
    [61000, "01:01"],
    [189000, "03:09"],
    [3599999, "59:59"],
    [3600000, "01:00:00"],
    [3660000, "01:01:00"],
    [5013000, "01:23:33"],
    [86400000, "24:00:00"],
    [360000000, "100:00:00"],
  ] as const) {
    assert.equal(formatDuration(ms), expected);
  }
});

test("stopped duration has no spaces and keeps zero fields below the highest used unit", () => {
  for (const [ms, expected] of [
    [0, "00s"],
    [999, "00s"],
    [5000, "05s"],
    [60000, "01m00s"],
    [133000, "02m13s"],
    [324000, "05m24s"],
    [3599999, "59m59s"],
    [3600000, "01h00m00s"],
    [3605000, "01h00m05s"],
    [5415000, "01h30m15s"],
    [86400000, "24h00m00s"],
    [360000000, "100h00m00s"],
  ] as const) {
    assert.equal(formatDuration(ms, "units"), expected);
  }
});
