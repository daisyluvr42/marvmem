import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readMarkdownEntries(path: string): Promise<string[]> {
  try {
    return parseMarkdownEntries(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

export async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => `${dir}/${entry.name}`)
      .sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export async function writeMarkdownListFile(
  path: string,
  entries: string[],
  maxChars?: number,
): Promise<void> {
  const rendered = renderMarkdownList(entries, maxChars);
  await writeText(path, rendered ? `${rendered}\n` : "");
}

export async function writeMarkdownBlocksFile(path: string, blocks: string[]): Promise<void> {
  const rendered = blocks.map((block) => block.trim()).filter(Boolean).join("\n\n").trim();
  await writeText(path, rendered ? `${rendered}\n` : "");
}

export function parseMarkdownEntries(content: string): string[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const entries: string[] = [];
  const paragraph: string[] = [];
  let inFrontmatter = false;
  let inCodeFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line && paragraph.length > 0) {
      entries.push(paragraph.join(" ").trim());
      paragraph.length = 0;
      continue;
    }
    if (!line) {
      continue;
    }
    if (!inFrontmatter && entries.length === 0 && paragraph.length === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---") {
        inFrontmatter = false;
      }
      continue;
    }
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || line.startsWith("#")) {
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      if (paragraph.length > 0) {
        entries.push(paragraph.join(" ").trim());
        paragraph.length = 0;
      }
      if (bullet[1]?.trim()) {
        entries.push(bullet[1].trim());
      }
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      if (paragraph.length > 0) {
        entries.push(paragraph.join(" ").trim());
        paragraph.length = 0;
      }
      if (ordered[1]?.trim()) {
        entries.push(ordered[1].trim());
      }
      continue;
    }
    paragraph.push(line);
  }

  if (paragraph.length > 0) {
    entries.push(paragraph.join(" ").trim());
  }

  return entries.filter(Boolean);
}

export function renderMarkdownList(entries: string[], maxChars?: number): string {
  const newestFirst = entries.map((entry) => entry.trim()).filter(Boolean);
  if (!maxChars || maxChars <= 0) {
    return newestFirst.reverse().map((entry) => `- ${entry}`).join("\n");
  }

  const selected: string[] = [];
  let total = 0;
  for (const entry of newestFirst) {
    const line = `- ${entry}`;
    const nextTotal = total === 0 ? line.length : total + 1 + line.length;
    if (selected.length > 0 && nextTotal > maxChars) {
      break;
    }
    if (selected.length === 0 && line.length > maxChars) {
      selected.push(line.slice(0, maxChars).trimEnd());
      break;
    }
    selected.push(line);
    total = nextTotal;
  }
  return selected.reverse().join("\n");
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
