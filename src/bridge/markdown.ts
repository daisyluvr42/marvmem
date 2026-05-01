/**
 * Bridge-level markdown utilities.
 * Re-exports from the existing adapters/markdown-sync module
 * plus bridge-specific helpers.
 */
export {
  parseMarkdownEntries,
  renderMarkdownList,
  readMarkdownEntries,
  readTextFile,
  listMarkdownFiles,
  writeMarkdownListFile,
  writeMarkdownBlocksFile,
} from "../adapters/markdown-sync.js";
