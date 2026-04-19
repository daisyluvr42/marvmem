#!/usr/bin/env node
/**
 * MarvMem LoCoMo Benchmark
 * 
 * Tests MarvMem's retrieval against LoCoMo (10 multi-turn conversations, 1986 QA pairs).
 * Each conversation has ~20-35 sessions between two speakers.
 * Evidence format: "D<session>:<turn>" maps to session_<session>.
 * 
 * For each QA pair within each conversation:
 *   1. Ingest all sessions as palace records
 *   2. Query with memory.search()
 *   3. Check if the ground-truth session(s) are in top-K
 * 
 * Usage:
 *   node --experimental-strip-types benchmarks/locomo/bench.ts [options]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Import MarvMem from the built dist (run from project root: node --experimental-strip-types benchmarks/locomo/bench.ts)
const marvmemPath = resolve(import.meta.dirname, "../../dist/index.js");
const { createMarvMem, InMemoryStore } = await import(marvmemPath);

// ── Types ──────────────────────────────────────────────────────────────
const CATEGORY_NAMES: Record<number, string> = {
  1: "single-hop",
  2: "temporal",
  3: "open-domain",
  4: "adversarial",
  5: "temporal-inference",
};

type Turn = { speaker: string; dia_id: string; text: string };
type QA = { question: string; answer: string | number; evidence: string[]; category: number };
type Conversation = {
  sample_id: string;
  qa: QA[];
  conversation: Record<string, unknown>;
  session_summary?: unknown[];
};

type BenchResult = {
  convId: string;
  questionIdx: number;
  category: string;
  question: string;
  groundTruthSessions: string[];
  retrievedSessions: string[];
  retrievedScores: number[];
  hitAt5: boolean;
  hitAt10: boolean;
  ndcg10: number;
  elapsedMs: number;
};

// ── Helpers ────────────────────────────────────────────────────────────
function extractSessions(conv: Record<string, unknown>): Map<string, { text: string; date: string }> {
  const sessions = new Map<string, { text: string; date: string }>();
  const keys = Object.keys(conv);
  
  for (const key of keys) {
    const match = key.match(/^session_(\d+)$/);
    if (!match) continue;
    const sessionNum = match[1];
    const dateKey = `session_${sessionNum}_date_time`;
    const date = (conv[dateKey] as string) || "";
    const turns = conv[key] as Turn[];
    if (!Array.isArray(turns)) continue;
    
    const text = turns.map(t => `${t.speaker}: ${t.text}`).join("\n");
    sessions.set(`session_${sessionNum}`, { text, date });
  }
  return sessions;
}

function evidenceToSessions(evidence: string[]): string[] {
  // D1:3 → session_1, D2:8 → session_2
  const sessions = new Set<string>();
  for (const e of evidence) {
    const match = e.match(/^D(\d+)/);
    if (match) sessions.add(`session_${match[1]}`);
  }
  return [...sessions];
}

function recallAtK(retrieved: string[], groundTruth: string[], k: number): boolean {
  const topK = new Set(retrieved.slice(0, k));
  return groundTruth.some(id => topK.has(id));
}

function ndcgAtK(retrieved: string[], groundTruth: string[], k: number): number {
  const topK = retrieved.slice(0, k);
  const gtSet = new Set(groundTruth);
  for (let i = 0; i < topK.length; i++) {
    if (gtSet.has(topK[i])) return 1 / Math.log2(i + 2);
  }
  return 0;
}

// ── CLI args ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let dataPath = resolve(import.meta.dirname, "locomo10.json");
  let topK = 10;
  let limit = 0;
  let outputPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) dataPath = resolve(args[++i]);
    else if (args[i] === "--top-k" && args[i + 1]) topK = parseInt(args[++i], 10);
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === "--output" && args[i + 1]) outputPath = resolve(args[++i]);
  }

  if (!outputPath) {
    const ts = new Date().toISOString().replace(/[:-]/g, "").slice(0, 15);
    const resultsDir = resolve(import.meta.dirname, "../results");
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    outputPath = resolve(resultsDir, `locomo_marvmem_${ts}.jsonl`);
  }

  return { dataPath, topK, limit, outputPath };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  console.log(`\n🧠 MarvMem × LoCoMo Benchmark`);
  console.log(`   Data:    ${opts.dataPath}`);
  console.log(`   Top-K:   ${opts.topK}`);
  console.log(`   Output:  ${opts.outputPath}\n`);

  const raw = readFileSync(opts.dataPath, "utf-8");
  const conversations: Conversation[] = JSON.parse(raw);
  console.log(`Loaded ${conversations.length} conversations\n`);

  const allResults: BenchResult[] = [];
  const startTime = Date.now();

  for (const conv of conversations) {
    const sessions = extractSessions(conv.conversation as Record<string, unknown>);
    console.log(`Conv ${conv.sample_id}: ${sessions.size} sessions, ${conv.qa.length} QAs`);

    // Create one MarvMem instance per conversation (all sessions ingested)
    const memory = createMarvMem({
      store: new InMemoryStore(),
      dedupeThreshold: 1,
    });

    // Ingest all sessions
    for (const [sessionId, { text, date }] of sessions) {
      const content = date ? `[Date: ${date}]\n${text}` : text;
      await memory.remember({
        scope: { type: "session", id: sessionId },
        kind: "session",
        content,
        importance: 0.5,
        tags: [],
        metadata: { sessionId, date },
      });
    }

    // Query each QA pair
    let convHits = 0;
    for (let qi = 0; qi < conv.qa.length; qi++) {
      const qa = conv.qa[qi];
      const qStart = Date.now();
      const gtSessions = evidenceToSessions(qa.evidence);

      const hits = await memory.search(qa.question, {
        maxResults: opts.topK,
        minScore: 0,
      });

      const retrievedSessions = hits.map((h: any) => h.record.scope.id);
      const retrievedScores = hits.map((h: any) => h.score);

      const result: BenchResult = {
        convId: conv.sample_id,
        questionIdx: qi,
        category: CATEGORY_NAMES[qa.category] || String(qa.category),
        question: qa.question,
        groundTruthSessions: gtSessions,
        retrievedSessions,
        retrievedScores,
        hitAt5: recallAtK(retrievedSessions, gtSessions, 5),
        hitAt10: recallAtK(retrievedSessions, gtSessions, opts.topK),
        ndcg10: ndcgAtK(retrievedSessions, gtSessions, opts.topK),
        elapsedMs: Date.now() - qStart,
      };

      allResults.push(result);
      if (result.hitAt10) convHits++;
    }

    const convR10 = (convHits / conv.qa.length * 100).toFixed(1);
    console.log(`  → R@${opts.topK}: ${convR10}% (${convHits}/${conv.qa.length})`);
  }

  const totalMs = Date.now() - startTime;

  // ── Summary ────────────────────────────────────────────────────────
  const hit5 = allResults.filter(r => r.hitAt5).length;
  const hit10 = allResults.filter(r => r.hitAt10).length;
  const avgNdcg = allResults.reduce((s, r) => s + r.ndcg10, 0) / allResults.length;

  console.log(`\n${"━".repeat(60)}`);
  console.log(`MarvMem LoCoMo Results (top-${opts.topK})`);
  console.log(`${"━".repeat(60)}`);
  console.log(`Total QA pairs: ${allResults.length}`);
  console.log(`R@5:            ${(hit5 / allResults.length * 100).toFixed(1)}% (${hit5}/${allResults.length})`);
  console.log(`R@${opts.topK}:           ${(hit10 / allResults.length * 100).toFixed(1)}% (${hit10}/${allResults.length})`);
  console.log(`NDCG@${opts.topK}:        ${avgNdcg.toFixed(3)}`);
  console.log(`Time:           ${(totalMs / 1000).toFixed(1)}s (${(totalMs / allResults.length).toFixed(1)}ms/q)`);
  console.log(`${"━".repeat(60)}`);

  // Per-category
  const categories = new Map<string, BenchResult[]>();
  for (const r of allResults) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category)!.push(r);
  }

  console.log(`\nPer-category breakdown:`);
  console.log(`${"─".repeat(55)}`);
  console.log(`${"Category".padEnd(22)} ${"Count".padStart(5)} ${"R@5".padStart(7)} ${"R@10".padStart(7)} ${"NDCG".padStart(7)}`);
  console.log(`${"─".repeat(55)}`);

  const sorted = [...categories.entries()].sort((a, b) => {
    const ra = a[1].filter(r => r.hitAt10).length / a[1].length;
    const rb = b[1].filter(r => r.hitAt10).length / b[1].length;
    return rb - ra;
  });

  for (const [cat, items] of sorted) {
    const h5 = items.filter(r => r.hitAt5).length;
    const h10 = items.filter(r => r.hitAt10).length;
    const ndcg = items.reduce((s, r) => s + r.ndcg10, 0) / items.length;
    console.log(
      `${cat.padEnd(22)} ${String(items.length).padStart(5)} ${(h5 / items.length * 100).toFixed(1).padStart(6)}% ${(h10 / items.length * 100).toFixed(1).padStart(6)}% ${ndcg.toFixed(3).padStart(7)}`,
    );
  }
  console.log(`${"─".repeat(55)}`);

  // Write JSONL
  const dir = dirname(opts.outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(opts.outputPath, allResults.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  console.log(`\nResults written to: ${opts.outputPath}`);
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
