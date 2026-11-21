import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Marked, type Token, type Tokens } from "@earendil-works/pi-tui";

const markdown = new Marked();

function fileHref(candidate: string, cwd: string): string | undefined {
  // Line/column annotations belong to the label, not the filename.
  const path = candidate.replace(/:\d+(?::\d+)?$/, "");
  const drivePath = /^[a-z]:[\\/]/i.test(path);
  if (
    !path ||
    /[\x00-\x1f\x7f]/.test(path) ||
    /^[\\/]{2}/.test(path) ||
    (drivePath && process.platform !== "win32") ||
    (drivePath ? path.slice(2) : path).includes(":")
  )
    return;

  const absolute = /^~[\\/]/.test(path) ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  if (/^[\\/]{2}/.test(absolute)) return;
  try {
    if (statSync(absolute, { throwIfNoEntry: false })?.isFile()) return pathToFileURL(absolute).href;
  } catch {
    // An inaccessible or invalid path is still ordinary reply text.
  }
}

export function linkLocalFiles(source: string, cwd: string): string {
  const checked = new Map<string, string | undefined>();
  function link(label: string, path: string): string {
    if (!checked.has(path)) checked.set(path, fileHref(path, cwd));
    const href = checked.get(path);
    return href ? `[${label}](<${href}>)` : label;
  }

  // Edit only the original source spans. Never reserialize the reply (lists,
  // indentation, reference definitions, etc. must survive the display hook).
  function rewrite(raw: string, tokens: Token[]): string {
    let output = "";
    let cursor = 0;
    for (const token of tokens) {
      const start = raw.indexOf(token.raw, cursor);
      // Marked can normalize indentation/quote prefixes inside container blocks.
      if (start < 0) return raw;
      output += raw.slice(cursor, start) + render(token);
      cursor = start + token.raw.length;
    }
    return output + raw.slice(cursor);
  }

  function render(token: Token): string {
    const { raw } = token;
    switch (token.type) {
      case "codespan":
        return link(raw, token.text);
      case "text":
        if (token.tokens) return rewrite(raw, token.tokens);
        // Take complete words, not a filename-looking substring of a URL or path.
        return raw.replace(/[^\s,;!?()"'`<>|，。；：！？、（）“”‘’]+/gu, (word) => {
          const path = word.replace(/[.:]+$/, "");
          if (!/^(?:[a-z]:[\\/])?[\p{L}\p{M}\p{N}_.~+@/\\-]+(?::\d+(?::\d+)?)?$/iu.test(path)) return word;
          return link(path, path) + word.slice(path.length);
        });
      case "link": {
        // A relative Markdown destination isn't a usable terminal URI. Keep the
        // original label and optional title; replace just a simple local target.
        const inline = /^(\[[\s\S]*\]\(\s*)(<[^>\n]+>|[^()\s]+)([\s\S]*\))$/.exec(raw);
        if (!inline || (inline[2] !== token.href && inline[2] !== `<${token.href}>`)) return raw;
        const href = fileHref(token.href, cwd);
        return href ? `${inline[1]}<${href}>${inline[3]}` : raw;
      }
      case "table": {
        const { header, rows } = token as Tokens.Table;
        return rewrite(
          raw,
          [header, ...rows].flat().map(({ text, tokens }) => ({ type: "paragraph", raw: text, tokens })),
        );
      }
      case "list":
        return rewrite(raw, token.items);
      case "paragraph":
      case "heading":
      case "blockquote":
      case "list_item":
      case "strong":
      case "em":
      case "del":
        return rewrite(raw, token.tokens ?? []);
      default:
        // In particular, leave images, definitions and code blocks alone.
        return raw;
    }
  }

  const normalized = source.replace(/\r\n?/g, "\n"); // Marked uses LF internally.
  const result = rewrite(normalized, markdown.lexer(normalized));
  if (result === normalized) return source;
  if (source === normalized) return result;
  const endings = source.matchAll(/\r\n?|\n/g);
  return result.replace(/\n/g, () => endings.next().value![0]);
}

export default function fileLinks(pi: ExtensionAPI) {
  let cwd: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.mode === "tui" ? ctx.cwd : undefined;
  });
  pi.registerMarkdownTransformer(
    (source, { isStreaming }) =>
      cwd && !isStreaming && getCapabilities().hyperlinks ? linkLocalFiles(source, cwd) : source,
    { messageTypes: ["assistant"] },
  );
}
