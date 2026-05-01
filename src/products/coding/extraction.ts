import type { CapturedMemoryProposal } from "../../runtime/types.js";

// ---------------------------------------------------------------------------
// Coding-focused extraction patterns
// ---------------------------------------------------------------------------

const CODING_PATTERNS: Array<{
  pattern: RegExp;
  kind: string;
  tags: string[];
}> = [
  {
    pattern: /(this repo uses|we use|our repo|项目使用|这个仓库用)/iu,
    kind: "repo_convention",
    tags: ["repo", "convention"],
  },
  {
    pattern: /(run tests|build with|deploy using|package manager|测试用|构建用|部署用)/iu,
    kind: "workflow_rule",
    tags: ["workflow"],
  },
  {
    pattern: /(do not edit|don't edit|never modify|不要编辑|不要修改|禁止)/iu,
    kind: "repo_convention",
    tags: ["repo", "rule"],
  },
  {
    pattern: /(prefer|always use|we follow|style guide|代码风格|始终使用|遵循)/iu,
    kind: "repo_convention",
    tags: ["repo", "style"],
  },
  {
    pattern: /(non-interactive|no prompt|自动|无交互)/iu,
    kind: "workflow_rule",
    tags: ["workflow", "automation"],
  },
];

/**
 * Analyze a turn for coding-specific memory extraction.
 * Returns additional proposals biased toward repo_convention and workflow_rule.
 */
export function extractCodingProposals(input: {
  userMessage: string;
  assistantMessage?: string;
}): CapturedMemoryProposal[] {
  const text = input.userMessage.trim();
  if (!text) {
    return [];
  }

  const proposals: CapturedMemoryProposal[] = [];

  for (const { pattern, kind, tags } of CODING_PATTERNS) {
    if (pattern.test(text)) {
      proposals.push({
        kind,
        content: text,
        summary: text.length <= 120 ? text : `${text.slice(0, 117)}...`,
        confidence: 0.85,
        importance: 0.85,
        source: "coding_extraction",
        tags: ["coding", ...tags],
      });
      break; // One match per message to avoid duplicates
    }
  }

  return proposals;
}
