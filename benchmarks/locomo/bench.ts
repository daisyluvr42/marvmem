#!/usr/bin/env node
/**
 * MarvMem LoCoMo Benchmark — with optional remote embedding rerank
 * 
 * Usage:
 *   # Baseline (hash only)
 *   node --experimental-strip-types benchmarks/locomo/bench.ts
 * 
 *   # With BGE-M3 via LM Studio
 *   node --experimental-strip-types benchmarks/locomo/bench.ts \
 *     --embed-url http://127.0.0.1:1234 --embed-model text-embedding-bge-m3
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const marvmemPath = resolve(import.meta.dirname, "../../dist/index.js");
const { createMarvMem, InMemoryStore } = await import(marvmemPath);

const hashEmbPath = resolve(import.meta.dirname, "../../dist/core/hash-embedding.js");
const { cosineSimilarity } = await import(hashEmbPath);

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

// ── Embedding client ───────────────────────────────────────────────────
type EmbedProvider = "openai" | "gemini";

class RemoteEmbedder {
  private readonly provider: EmbedProvider;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly maxChars: number;

  constructor(opts: {
    provider: EmbedProvider;
    baseUrl: string;
    model: string;
    apiKey?: string;
    batchSize?: number;
    maxChars?: number;
  }) {
    this.provider = opts.provider;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey ?? "";
    this.batchSize = opts.batchSize ?? (opts.provider === "gemini" ? 20 : 4);
    this.maxChars = opts.maxChars ?? 4_000;
  }

  async embed(texts: string[], taskType: "query" | "document" = "document"): Promise<number[][]> {
    const truncated = texts.map(t => t.length > this.maxChars ? t.slice(0, this.maxChars) : t);
    if (this.provider === "gemini") return this.embedGemini(truncated, taskType);
    return this.embedOpenAI(truncated);
  }

  async embedOne(text: string): Promise<number[]> {
    return (await this.embed([text], "query"))[0];
  }

  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
      const data = (await response.json()) as { data: { embedding: number[] }[] };
      for (const item of data.data) allVectors.push(item.embedding);
    }
    return allVectors;
  }

  private async embedGemini(texts: string[], taskType: "query" | "document"): Promise<number[][]> {
    const geminiTask = taskType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const requests = batch.map(text => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: geminiTask,
      }));
      const response = await fetch(
        `${this.baseUrl}/v1beta/models/${this.model}:batchEmbedContents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify({ requests }),
        },
      );
      if (!response.ok) throw new Error(`Gemini embedding failed: ${response.status}`);
      const data = (await response.json()) as { embeddings: { values: number[] }[] };
      for (const item of data.embeddings) allVectors.push(item.values);
    }
    return allVectors;
  }
}

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

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ── CLI args ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let dataPath = resolve(import.meta.dirname, "locomo10.json");
  let topK = 10;
  let limit = 0;
  let outputPath = "";
  let embedProvider: EmbedProvider = "openai";
  let embedUrl = "";
  let embedModel = "";
  let embedKey = "";
  let embedBatch = 0;
  let embedWeight = 0.35;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && args[i + 1]) dataPath = resolve(args[++i]);
    else if (args[i] === "--top-k" && args[i + 1]) topK = parseInt(args[++i], 10);
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === "--output" && args[i + 1]) outputPath = resolve(args[++i]);
    else if (args[i] === "--embed-provider" && args[i + 1]) embedProvider = args[++i] as EmbedProvider;
    else if (args[i] === "--embed-url" && args[i + 1]) embedUrl = args[++i];
    else if (args[i] === "--embed-model" && args[i + 1]) embedModel = args[++i];
    else if (args[i] === "--embed-key" && args[i + 1]) embedKey = args[++i];
    else if (args[i] === "--embed-batch" && args[i + 1]) embedBatch = parseInt(args[++i], 10);
    else if (args[i] === "--embed-weight" && args[i + 1]) embedWeight = parseFloat(args[++i]);
  }

  if (!embedUrl && embedProvider === "gemini") embedUrl = "https://generativelanguage.googleapis.com";
  if (!embedModel && embedProvider === "gemini") embedModel = "gemini-embedding-001";

  if (!outputPath) {
    const ts = new Date().toISOString().replace(/[:-]/g, "").slice(0, 15);
    const tag = embedModel ? `_${embedModel.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
    const resultsDir = resolve(import.meta.dirname, "../results");
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    outputPath = resolve(resultsDir, `locomo_marvmem${tag}_${ts}.jsonl`);
  }

  const embedder = (embedUrl && embedModel) ? new RemoteEmbedder({
    provider: embedProvider, baseUrl: embedUrl, model: embedModel,
    apiKey: embedKey, batchSize: embedBatch || undefined,
  }) : null;
  return { dataPath, topK, limit, outputPath, embedder, embedWeight };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const mode = opts.embedder ? `hybrid (${opts.embedWeight * 100}% vector)` : "builtin (hash only)";
  console.log(`\n🧠 MarvMem × LoCoMo Benchmark`);
  console.log(`   Mode:    ${mode}`);
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

    const memory = createMarvMem({
      store: new InMemoryStore(),
      dedupeThreshold: 1,
    });

    // Ingest all sessions
    const sessionTexts = new Map<string, string>();
    for (const [sessionId, { text, date }] of sessions) {
      const content = date ? `[Date: ${date}]\n${text}` : text;
      sessionTexts.set(sessionId, content);
      await memory.remember({
        scope: { type: "session", id: sessionId },
        kind: "session",
        content,
        importance: 0.5,
        tags: [],
        metadata: { sessionId, date },
      });
    }

    // Pre-embed all sessions once per conversation (much faster than per-question)
    let sessionVecs: Map<string, number[]> | null = null;
    if (opts.embedder) {
      const ids = [...sessionTexts.keys()];
      const texts = ids.map(id => sessionTexts.get(id)!);
      const vecs = await opts.embedder.embed(texts);
      sessionVecs = new Map();
      for (let i = 0; i < ids.length; i++) {
        sessionVecs.set(ids[i], vecs[i]);
      }
      console.log(`  Embedded ${ids.length} sessions`);
    }

    // Query each QA pair
    let convHits = 0;
    for (let qi = 0; qi < conv.qa.length; qi++) {
      const qa = conv.qa[qi];
      const qStart = Date.now();
      const gtSessions = evidenceToSessions(qa.evidence);

      const candidatePool = opts.embedder ? 20 : opts.topK;
      const hits = await memory.search(qa.question, {
        maxResults: candidatePool,
        minScore: 0,
      });

      let finalHits: { id: string; score: number }[];

      if (opts.embedder && sessionVecs && hits.length > 0) {
        const queryVec = await opts.embedder.embedOne(qa.question);
        const builtinWeight = 1 - opts.embedWeight;
        finalHits = hits.map((h: any) => {
          const sid = h.record.scope.id as string;
          const sVec = sessionVecs!.get(sid);
          const vecScore = sVec ? clamp(cosineSimilarity(queryVec, sVec), 0, 1) : 0;
          return {
            id: sid,
            score: h.score * builtinWeight + vecScore * opts.embedWeight,
          };
        });
        finalHits.sort((a, b) => b.score - a.score);
      } else {
        finalHits = hits.map((h: any) => ({
          id: h.record.scope.id as string,
          score: h.score as number,
        }));
      }

      const retrievedSessions = finalHits.map(h => h.id);
      const retrievedScores = finalHits.map(h => h.score);

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
  console.log(`MarvMem LoCoMo Results [${mode}] (top-${opts.topK})`);
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
