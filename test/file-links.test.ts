import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, setCapabilityOverrides } from "@earendil-works/pi-tui";
import register, { linkLocalFiles } from "../src/file-links.ts";

function project(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bar-links-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src"));
  for (const path of ["README.md", "LICENSE", "src/foo.ts", "src/说明 #1 (50%).md"]) writeFileSync(join(cwd, path), "");
  return { cwd, href: (path: string) => pathToFileURL(join(cwd, path)).href };
}

test("local files resolve against the session cwd; only the displayed label includes line/column", (t) => {
  const { cwd, href } = project(t);
  const absolute = join(cwd, "src", "foo.ts");
  const source = `- **README.md**，LICENSE。\r\n- src/foo.ts:12:3, \`${absolute}\`\n\nfoo.ts src missing.md`;
  assert.equal(
    linkLocalFiles(source, cwd),
    `- **[README.md](<${href("README.md")}>)**，[LICENSE](<${href("LICENSE")}>)。\r\n- [src/foo.ts:12:3](<${href("src/foo.ts")}>)` +
      `, [\`${absolute}\`](<${href("src/foo.ts")}>)\n\nfoo.ts src missing.md`,
  );
});

test("protects links, images, definitions, remote paths and code blocks from nested links", (t) => {
  const { cwd } = project(t);
  const source = [
    "[README.md](https://example.org/README.md) ![README.md](README.md)",
    "[README.md][docs] <https://example.org/README.md>",
    "",
    "[docs]: https://example.org/README.md",
    "",
    "~~~ts",
    "README.md",
    "~~~",
    "",
    "    README.md",
    "",
    "`//server/share/file` `https://example.org/README.md` `cat README.md`",
  ].join("\n");
  assert.equal(linkLocalFiles(source, cwd), source);
});

test("Pi renders encoded local OSC 8 links without exposing URLs or changing labels", (t) => {
  const { cwd, href } = project(t);
  const name = "src/说明 #1 (50%).md";
  const theme = new Proxy({} as MarkdownTheme, { get: () => (text: string) => text });
  setCapabilityOverrides({ hyperlinks: true });
  t.after(() => setCapabilityOverrides({}));
  for (const [source, label, path] of [
    ["| File |\n| --- |\n| `" + name + "` |", name, name],
    ['[the source](src/foo.ts "title")', "the source", "src/foo.ts"],
  ]) {
    const transformed = linkLocalFiles(source, cwd);
    assert.equal(linkLocalFiles(transformed, cwd), transformed);
    const lines = new Markdown(transformed, 0, 0, theme).render(140);
    assert.ok(lines.some((line) => line.includes(`\x1b]8;;${href(path)}\x1b\\${label}\x1b]8;;\x1b\\`)));
  }
});

test("entry registers only an assistant display hook and falls back without hyperlinks", (t) => {
  const { cwd, href } = project(t);
  let start!: (event: unknown, ctx: Pick<ExtensionContext, "mode" | "cwd">) => void;
  let transform!: MarkdownTransformer;
  register({
    on(name: string, handler: typeof start) {
      assert.equal(name, "session_start");
      start = handler;
    },
    registerMarkdownTransformer(fn: MarkdownTransformer, options: unknown) {
      assert.deepEqual(options, { messageTypes: ["assistant"] });
      transform = fn;
    },
  } as unknown as ExtensionAPI);
  const apply = (isStreaming: boolean) =>
    transform("README.md", { isStreaming, messageType: "assistant", availableWidth: 80 });
  start({}, { mode: "tui", cwd });
  setCapabilityOverrides({ hyperlinks: false });
  t.after(() => setCapabilityOverrides({}));
  assert.equal(apply(false), "README.md");
  setCapabilityOverrides({ hyperlinks: true });
  assert.equal(apply(true), "README.md");
  assert.equal(apply(false), `[README.md](<${href("README.md")}>)`);
  start({}, { mode: "rpc", cwd });
  assert.equal(apply(false), "README.md");
});
