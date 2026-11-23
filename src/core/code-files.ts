import type { MessageEntity } from "grammy/types";

/**
 * What an answer's code becomes in the chat. The model fences code with its language; a block of up to about a screen
 * stays in the message as a code block, and a longer one goes out as a file named after its language, with a 📎 line
 * where it was. Until 2026-11-23 long code went out as plain text mixed with the prose, or was not posted at all.
 */

/** About a screen of code: a longer block goes out as a file. */
export const MAX_INLINE_CODE_LINES = 25;
/** Files one answer may send, and the size of each: within what one answer holds anyway. */
export const MAX_CODE_FILES = 3;
export const MAX_CODE_FILE_CHARS = 12_000;
/** Telegram takes 4,096 characters a message; the rest is a margin. */
const MAX_MESSAGE_CHARS = 3900;

/** The languages whose code goes out as a file, and the file each becomes: scripts are «script», the rest «snippet». */
const FILE_NAMES = new Map<string, string>(Object.entries({
  python: "script.py", py: "script.py", python3: "script.py",
  javascript: "script.js", js: "script.js", node: "script.js", mjs: "script.mjs",
  typescript: "snippet.ts", ts: "snippet.ts", tsx: "snippet.tsx", jsx: "snippet.jsx",
  swift: "snippet.swift", kotlin: "snippet.kt", kt: "snippet.kt", java: "snippet.java", scala: "snippet.scala", groovy: "snippet.groovy",
  go: "snippet.go", golang: "snippet.go", rust: "snippet.rs", rs: "snippet.rs", zig: "snippet.zig",
  c: "snippet.c", cpp: "snippet.cpp", "c++": "snippet.cpp", cc: "snippet.cpp", h: "snippet.h", hpp: "snippet.hpp",
  csharp: "snippet.cs", cs: "snippet.cs", "c#": "snippet.cs", objc: "snippet.m", "objective-c": "snippet.m",
  dart: "snippet.dart", elixir: "snippet.ex", haskell: "snippet.hs", clojure: "snippet.clj", julia: "snippet.jl", solidity: "snippet.sol",
  ruby: "script.rb", rb: "script.rb", php: "script.php", perl: "script.pl", lua: "script.lua", r: "script.R",
  bash: "script.sh", sh: "script.sh", shell: "script.sh", zsh: "script.zsh", powershell: "script.ps1", ps1: "script.ps1",
  sql: "query.sql", postgresql: "query.sql", postgres: "query.sql", mysql: "query.sql", sqlite: "query.sql", graphql: "query.graphql",
  html: "index.html", css: "styles.css", scss: "styles.scss", vue: "component.vue", svelte: "component.svelte",
  json: "data.json", yaml: "config.yaml", yml: "config.yaml", toml: "config.toml", xml: "data.xml", ini: "config.ini",
  dockerfile: "Dockerfile", docker: "Dockerfile", makefile: "Makefile", make: "Makefile", nginx: "nginx.conf",
  terraform: "main.tf", hcl: "main.tf", proto: "schema.proto", protobuf: "schema.proto",
}));

/** Fences around words rather than code: what they hold is shown and counted as the answer's words, never sent as a file. */
const WORD_FENCES = new Set(["text", "txt", "plain", "plaintext", "markdown", "md"]);
/** Markup, whose text between its tags is words as well. */
const MARKUP = new Set(["html", "xml", "vue", "svelte"]);
/** Data, whose strings are its values: a block of it is never a text fenced as code, however many of them it holds. */
const DATA = new Set(["json", "yaml", "yml", "toml", "ini"]);
/**
 * Strings and comments in most languages: triple-quoted, backticked and quoted strings, block comments, and a comment to
 * the end of its line («// …», «# …», «-- …», «; …»; «#include» and «#!/bin/sh» are none).
 */
const PROSE = /"""([\s\S]*?)"""|'''([\s\S]*?)'''|`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|\/\*([\s\S]*?)\*\/|<!--([\s\S]*?)-->|(?:^|[ \t])(?:\/\/|#(?=[ \t])|--(?=[ \t]))([^\n]*)|^[ \t]*;+([^\n]*)/gm;
/** Code whose comments and strings hold more of its letters than this is a text fenced as code. */
const MOSTLY_WORDS = 0.75;

/**
 * The words in a block of code: its comments, the text of its strings and, in markup, the text between its tags. Pressure
 * that gets no story out of the model as words may get one as a program that prints it, so these words keep the rules an
 * answer's words keep.
 */
export function proseOf(code: string, language: string): string[] {
  const segments: string[] = [];
  const keep = (text: string | undefined) => {
    if (text && /\p{L}/u.test(text)) segments.push(text.trim());
  };
  for (const match of code.matchAll(PROSE)) keep(match.slice(1).find((group) => group !== undefined));
  if (MARKUP.has(language)) {
    const tags = code.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/giu, "<>");
    for (const match of tags.matchAll(/>([^<]+)</g)) keep(match[1]);
  }
  return segments;
}

const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;

export interface CodeFile {
  name: string;
  content: string;
}

export interface AnswerParts {
  /** The message: the answer's words, the code kept in it, and a 📎 line for each file. */
  text: string;
  /** The code kept in the message, as Telegram's code blocks (`pre`) with their language. */
  entities: MessageEntity[];
  files: CodeFile[];
  /**
   * The answer's words alone, without its code: what the length rule for an answer holds to. A block of code that is
   * mostly comments and strings counts here whole, as the text it is.
   */
  words: string;
  /** The comments and strings of the rest of its code, each of which keeps the rules of an answer's words on its own. */
  prose: string[];
  /** Whether a fence was left open at the end, so the code may have been cut off. */
  unclosed: boolean;
}

type Words = { kind: "words"; text: string };
/** A block of code; `named` is the file name the model wrote after its language (```python cleanup_logs.py), if any. */
type Block = { kind: "code"; language: string; code: string; named?: string };

/**
 * A block with no language is shown as code, yet counted as words: nothing says it is code rather than a long text. So is
 * a block whose comments and strings are most of it, data aside: a story in a print() is still a story, while a JSON's
 * keys and values are all strings and still data.
 */
const countsAsWords = (block: Block) =>
  block.language === "" ||
  WORD_FENCES.has(block.language) ||
  (!DATA.has(block.language) && letters(proseOf(block.code, block.language).join("")) > MOSTLY_WORDS * letters(block.code));

/** A block's code without the blank lines around it. */
const trimmed = (lines: string[]) => lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");

/** The answer as lines of words and fenced blocks of code, in order. A fence left open runs to the end. */
function segmentsOf(answer: string): { segments: (Words | Block)[]; unclosed: boolean } {
  const segments: (Words | Block)[] = [];
  let open: { fence: string; language: string; named?: string; lines: string[] } | undefined;
  const block = ({ language, named, lines }: NonNullable<typeof open>): Block => ({ kind: "code", language, code: trimmed(lines), ...(named ? { named } : {}) });
  for (const line of answer.replace(/\r\n?/g, "\n").split("\n")) {
    if (open) {
      if (line.trim() === open.fence) {
        segments.push(block(open));
        open = undefined;
      } else open.lines.push(line);
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)(?:\s+([^\s`~]+))?[^`]*$/.exec(line);
    if (fence) open = { fence: fence[1]!, language: fence[2]!.toLowerCase(), ...(fence[3] ? { named: fence[3] } : {}), lines: [] };
    else segments.push({ kind: "words", text: line });
  }
  if (open) segments.push(block(open));
  return { segments, unclosed: open !== undefined };
}

/** A file name the model may give its code: a plain name of letters, digits, «_», «-» and dots, no path. */
const PLAIN_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,59}$/u;

/**
 * The file a block becomes: the name the model gave it after its language, so that its words and the file agree, when
 * that is a plain name with the language's own extension (cleanup_logs.py for python); else the language's own
 * (script.py). A name an earlier file of the answer took gets a number: script.py, script-2.py…
 */
function fileName(block: Block, taken: Set<string>): string {
  const own = FILE_NAMES.get(block.language)!;
  const extensionOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")).toLowerCase() : "");
  const base = block.named && PLAIN_NAME.test(block.named) && extensionOf(block.named) === extensionOf(own) && (extensionOf(own) !== "" || block.named === own) ? block.named : own;
  const dot = base.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  let name = base;
  for (let copy = 2; taken.has(name); copy += 1) name = `${stem}-${copy}${extension}`;
  taken.add(name);
  return name;
}

/** A message from lines of words and blocks of code: blank lines kept single, each block an entity in its place. */
function assemble(parts: (Words | Block)[]): { text: string; entities: MessageEntity[] } {
  const lines: (Words | Block)[] = [];
  const blank = (part: Words | Block | undefined) => part?.kind === "words" && !part.text.trim();
  for (const part of parts) {
    if (part.kind === "words" && !part.text.trim() && (lines.length === 0 || blank(lines.at(-1)))) continue;
    lines.push(part.kind === "words" ? { kind: "words", text: part.text.trimEnd() } : part);
  }
  while (blank(lines.at(-1))) lines.pop();
  let text = "";
  const entities: MessageEntity[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) text += "\n";
    if (line.kind === "code") {
      entities.push({ type: "pre", offset: text.length, length: line.code.length, ...(line.language ? { language: line.language } : {}) });
      text += line.code;
    } else text += line.text;
  }
  return { text, entities };
}

/** A block's lines as lines of words. */
const asWords = (block: Block): Words[] => block.code.split("\n").map((text) => ({ kind: "words", text }));

/**
 * Splits an answer into its message and its files. A block of code over MAX_INLINE_CODE_LINES in a language listed in
 * FILE_NAMES goes out as a file, and so does a shorter one, the longest first, while the message would not fit into one
 * otherwise; the rest stays in the message as code blocks. A block of words («text», «markdown») stays in the message as
 * words, and a block with no language as code; both count as the answer's words.
 */
export function answerParts(answer: string): AnswerParts {
  const { segments, unclosed } = segmentsOf(answer);
  const blocks = segments.filter((segment): segment is Block => segment.kind === "code" && segment.code !== "");
  const fileable = (block: Block) => FILE_NAMES.has(block.language);
  const filed = new Set(blocks.filter((block) => fileable(block) && block.code.split("\n").length > MAX_INLINE_CODE_LINES));
  const build = () => {
    const taken = new Set<string>();
    const files: CodeFile[] = [];
    const parts = segments.flatMap((segment): (Words | Block)[] => {
      if (segment.kind === "words") return [segment];
      if (!segment.code) return [];
      if (WORD_FENCES.has(segment.language)) return asWords(segment);
      if (!filed.has(segment)) return [segment];
      const name = fileName(segment, taken);
      files.push({ name, content: `${segment.code}\n` });
      return [{ kind: "words", text: `📎 ${name}` }];
    });
    return { ...assemble(parts), files };
  };
  let built = build();
  for (const block of blocks.filter((block) => fileable(block) && !filed.has(block)).sort((a, b) => b.code.length - a.code.length)) {
    if (built.text.length <= MAX_MESSAGE_CHARS) break;
    filed.add(block);
    built = build();
  }
  const words = assemble(segments.flatMap((segment): Words[] => (segment.kind === "words" ? [segment] : countsAsWords(segment) ? asWords(segment) : []))).text;
  const prose = blocks.filter((block) => !countsAsWords(block)).flatMap((block) => proseOf(block.code, block.language));
  return { ...built, words, prose, unclosed };
}

/** Whether the parts are more than one answer sends: a message over Telegram's limit, too many files or too big a one. */
export function overLimits(parts: AnswerParts): boolean {
  return parts.text.length > MAX_MESSAGE_CHARS || parts.files.length > MAX_CODE_FILES || parts.files.some((file) => file.content.length > MAX_CODE_FILE_CHARS);
}
