#!/usr/bin/env node
/**
 * MarvMem LongMemEval Benchmark
 * 
 * Tests MarvMem's retrieval against the LongMemEval dataset (500 questions, ~19k sessions).
 * 
 * For each question:
 *   1. Ingest all haystack sessions as palace records
 *   2. Query with memory.search()
 *   3. Check if the ground-truth session is in top-K
 * 
 * Usage:
 *   node --experimental-strip-types benchmarks/longmemeval/bench.ts [options]
 * 
 * Options:
 *   --data <path>     Path to longmemeval_s_cleaned.json (default: benchmarks/longmemeval/longmemeval_s_cleaned.json)
 *   --top-k <n>       Top-K to evaluate (default: 10)
 *   --limit <n>       Only run first N questions (default: all)
 *   --output <path>   JSONL output path (default: benchmarks/results/lme_marvmem_<timestamp>.jsonl)
 *   --weights <json>  Override search weights as JSON, e.g. '{"lexical":0.5,"hash":0.3}'
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Import MarvMem from the built dist (run from project root: node --experimental-strip-types benchmarks/longmemeval/bench.ts)
const marvmemPath = resolve(import.meta.dirname, "../../dist/index.js");
const { createMarvMem, InMemoryStore } = await import(marvmemPath);

// ── Types ──────────────────────────────────────────────────────────────
type Turn = { role: string; content: string };
type LMEQuestion = {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Record<string, Turn>[];
};

type BenchResult = {
  questionId: string;
  questionType: string;
  question: string;
  groundTruthIds: string[];
  retrievedIds: string[];
  retrievedScores: number[];
  hitAt5: boolean;
  hitAt10: boolean;
  ndcg5: number;
  ndcg10: number;
  elapsedMs: number;
  rank: number | null;  // rank of first ground-truth hit, null if not found
};

// ── Metrics ────────────────────────────────────────────────────────────
function recallAtK(retrievedIds: string[], groundTruthIds: string[], k: number): boolean {
  const topK = new Set(retrievedIds.slice(0, k));
  return groundTruthIds.some(id => topK.has(id));
}

function ndcgAtK(retrievedIds: string[], groundTruthIds: string[], k: number): number {
  const topK = retrievedIds.slice(0, k);
  const gtSet = new Set(groundTruthIds);
  for (let i = 0; i < topK.length; i++) {
    if (gtSet.has(topK[i])) return 1 / Math.log2(i + 2);
  }
  return 0;
}

function findRank(retrievedIds: string[], groundTruthIds: string[]): number | null {
  const gtSet = new Set(groundTruthIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (gtSet.has(retrievedIds[i])) return i + 1;
  }
  return null;
}

// ── Session text builder ───────────────────────────────────────────────
function buildSessionText(session: Record<string, Turn>, date?: string): string {
  const keys = Object.keys(session).sort((a, b) => Number(a) - Number(b));
  const turns = keys.map(k => {
    const t = session[k];
    return `${t.role}: ${t.content}`;
  });
  const header = date ? `[Date: ${date}]\n` : "";
  return header + turns.join("\n");
}

// ── CLI args ───────────────────────────────────────────────────────────
function parseArgs(): { dataPath: string; topK: number; limit: number; outputPath: string; weights: Record<string, number> | null } {
  const args = process.argv.slice(2);
  let dataPath = resolve(import.meta.dirname, "longmemeval_s_cleaned.json");
  let topK = 10;
  let limit = 0;
  let outputPath = "";
  let weights: Record<string, number> | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) dataPath = resolve(args[++i]);
    else if (args[i] === "--top-k" && args[i + 1]) topK = parseInt(args[++i], 10);
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === "--output" && args[i + 1]) outputPath = resolve(args[++i]);
    else if (args[i] === "--weights" && args[i + 1]) weights = JSON.parse(args[++i]);
  }

  if (!outputPath) {
    const ts = new Date().toISOString().replace(/[:-]/g, "").slice(0, 15);
    const resultsDir = resolve(import.meta.dirname, "../results");
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    outputPath = resolve(resultsDir, `lme_marvmem_${ts}.jsonl`);
  }

  return { dataPath, topK, limit, outputPath, weights };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  console.log(`\n🧠 MarvMem × LongMemEval Benchmark`);
  console.log(`   Data:    ${opts.dataPath}`);
  console.log(`   Top-K:   ${opts.topK}`);
  console.log(`   Limit:   ${opts.limit || "all"}`);
  console.log(`   Output:  ${opts.outputPath}\n`);

  // Load dataset
  console.log("Loading dataset...");
  const raw = readFileSync(opts.dataPath, "utf-8");
  const questions: LMEQuestion[] = JSON.parse(raw);
  const total = opts.limit > 0 ? Math.min(opts.limit, questions.length) : questions.length;
  console.log(`Loaded ${questions.length} questions, running ${total}\n`);

  const results: BenchResult[] = [];
  const startTime = Date.now();

  for (let qi = 0; qi < total; qi++) {
    const q = questions[qi];
    const qStart = Date.now();

    // Create a fresh in-memory MarvMem for each question (isolated haystack)
    const memory = createMarvMem({
      store: new InMemoryStore(),
      dedupeThreshold: 1,  // disable dedup — each session is unique
      ...(opts.weights ? { searchWeights: opts.weights } : {}),
    });

    // Ingest all haystack sessions as palace records
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const sessionText = buildSessionText(q.haystack_sessions[si], q.haystack_dates[si]);
      const sessionId = q.haystack_session_ids[si];
      await memory.remember({
        scope: { type: "session", id: sessionId },
        kind: "session",
        content: sessionText,
        importance: 0.5,
        tags: [],
        metadata: { sessionId, date: q.haystack_dates[si] },
      });
    }

    // Search
    const hits = await memory.search(q.question, {
      maxResults: Math.max(opts.topK, 10),
      minScore: 0,
    });

    // Map hits back to session IDs
    const retrievedIds = hits.map(h => h.record.scope.id);
    const retrievedScores = hits.map(h => h.score);

    const result: BenchResult = {
      questionId: q.question_id,
      questionType: q.question_type,
      question: q.question,
      groundTruthIds: q.answer_session_ids,
      retrievedIds,
      retrievedScores,
      hitAt5: recallAtK(retrievedIds, q.answer_session_ids, 5),
      hitAt10: recallAtK(retrievedIds, q.answer_session_ids, 10),
      ndcg5: ndcgAtK(retrievedIds, q.answer_session_ids, 5),
      ndcg10: ndcgAtK(retrievedIds, q.answer_session_ids, 10),
      elapsedMs: Date.now() - qStart,
      rank: findRank(retrievedIds, q.answer_session_ids),
    };

    results.push(result);

    // Progress
    const hitSymbol = result.hitAt5 ? "✅" : result.hitAt10 ? "🟡" : "❌";
    if ((qi + 1) % 25 === 0 || qi === total - 1) {
      const running5 = results.filter(r => r.hitAt5).length;
      const running10 = results.filter(r => r.hitAt10).length;
      console.log(
        `[${qi + 1}/${total}] R@5=${(running5 / results.length * 100).toFixed(1)}% R@10=${(running10 / results.length * 100).toFixed(1)}% | last: ${hitSymbol} ${q.question_type} rank=${result.rank ?? "miss"} (${result.elapsedMs}ms)`,
      );
    }
  }

  const totalMs = Date.now() - startTime;

  // ── Summary ────────────────────────────────────────────────────────
  const hit5 = results.filter(r => r.hitAt5).length;
  const hit10 = results.filter(r => r.hitAt10).length;
  const avgNdcg5 = results.reduce((s, r) => s + r.ndcg5, 0) / results.length;
  const avgNdcg10 = results.reduce((s, r) => s + r.ndcg10, 0) / results.length;

  console.log(`\n${"━".repeat(60)}`);
  console.log(`MarvMem LongMemEval Results`);
  console.log(`${"━".repeat(60)}`);
  console.log(`Questions: ${total}`);
  console.log(`R@5:       ${(hit5 / total * 100).toFixed(1)}% (${hit5}/${total})`);
  console.log(`R@10:      ${(hit10 / total * 100).toFixed(1)}% (${hit10}/${total})`);
  console.log(`NDCG@5:    ${avgNdcg5.toFixed(3)}`);
  console.log(`NDCG@10:   ${avgNdcg10.toFixed(3)}`);
  console.log(`Time:      ${(totalMs / 1000).toFixed(1)}s (${(totalMs / total).toFixed(0)}ms/q)`);
  console.log(`${"━".repeat(60)}`);

  // Per-category breakdown
  const categories = new Map<string, BenchResult[]>();
  for (const r of results) {
    if (!categories.has(r.questionType)) categories.set(r.questionType, []);
    categories.get(r.questionType)!.push(r);
  }

  console.log(`\nPer-category breakdown:`);
  console.log(`${"─".repeat(72)}`);
  console.log(
    `${"Category".padEnd(28)} ${"Count".padStart(5)} ${"R@5".padStart(7)} ${"R@10".padStart(7)} ${"NDCG@5".padStart(8)} ${"NDCG@10".padStart(8)}`,
  );
  console.log(`${"─".repeat(72)}`);

  const sorted = [...categories.entries()].sort((a, b) => {
    const ra = a[1].filter(r => r.hitAt5).length / a[1].length;
    const rb = b[1].filter(r => r.hitAt5).length / b[1].length;
    return rb - ra;
  });

  for (const [cat, items] of sorted) {
    const h5 = items.filter(r => r.hitAt5).length;
    const h10 = items.filter(r => r.hitAt10).length;
    const n5 = items.reduce((s, r) => s + r.ndcg5, 0) / items.length;
    const n10 = items.reduce((s, r) => s + r.ndcg10, 0) / items.length;
    console.log(
      `${cat.padEnd(28)} ${String(items.length).padStart(5)} ${(h5 / items.length * 100).toFixed(1).padStart(6)}% ${(h10 / items.length * 100).toFixed(1).padStart(6)}% ${n5.toFixed(3).padStart(8)} ${n10.toFixed(3).padStart(8)}`,
    );
  }
  console.log(`${"─".repeat(72)}`);

  // Miss analysis: show questions that missed at R@10
  const misses = results.filter(r => !r.hitAt10);
  if (misses.length > 0 && misses.length <= 30) {
    console.log(`\nMisses at R@10 (${misses.length}):`);
    for (const m of misses) {
      console.log(`  ${m.questionId} [${m.questionType}] "${m.question.slice(0, 80)}..."`);
    }
  }

  // Write JSONL
  const dir = dirname(opts.outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = results.map(r => JSON.stringify(r));
  writeFileSync(opts.outputPath, lines.join("\n") + "\n", "utf-8");
  console.log(`\nResults written to: ${opts.outputPath}`);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
