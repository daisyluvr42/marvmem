/**
 * Benchmark metrics: R@K, NDCG@K, and grouped statistics.
 */

export function recallAtK(retrievedIds: string[], groundTruthId: string, k: number): boolean {
  return retrievedIds.slice(0, k).includes(groundTruthId);
}

export function ndcgAtK(retrievedIds: string[], groundTruthId: string, k: number): number {
  const topK = retrievedIds.slice(0, k);
  const idx = topK.indexOf(groundTruthId);
  if (idx === -1) return 0;
  // DCG = 1 / log2(rank + 1), IDCG = 1 (perfect = rank 1)
  return 1 / Math.log2(idx + 2);
}

export type BenchResult = {
  questionId: string;
  questionType: string;
  question: string;
  groundTruthSessionId: string;
  retrievedIds: string[];
  retrievedScores: number[];
  hitAt5: boolean;
  hitAt10: boolean;
  ndcg5: number;
  ndcg10: number;
  elapsedMs: number;
};

export type CategoryStats = {
  category: string;
  total: number;
  hitAt5: number;
  hitAt10: number;
  recallAt5: number;
  recallAt10: number;
  avgNdcg5: number;
  avgNdcg10: number;
};

export function groupByCategory(results: BenchResult[]): Map<string, CategoryStats> {
  const groups = new Map<string, BenchResult[]>();
  for (const r of results) {
    const cat = r.questionType || "unknown";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(r);
  }
  const stats = new Map<string, CategoryStats>();
  for (const [cat, items] of groups) {
    const hit5 = items.filter(r => r.hitAt5).length;
    const hit10 = items.filter(r => r.hitAt10).length;
    stats.set(cat, {
      category: cat,
      total: items.length,
      hitAt5: hit5,
      hitAt10: hit10,
      recallAt5: hit5 / items.length,
      recallAt10: hit10 / items.length,
      avgNdcg5: items.reduce((s, r) => s + r.ndcg5, 0) / items.length,
      avgNdcg10: items.reduce((s, r) => s + r.ndcg10, 0) / items.length,
    });
  }
  return stats;
}

export function computeOverallStats(results: BenchResult[]): CategoryStats {
  const hit5 = results.filter(r => r.hitAt5).length;
  const hit10 = results.filter(r => r.hitAt10).length;
  return {
    category: "overall",
    total: results.length,
    hitAt5: hit5,
    hitAt10: hit10,
    recallAt5: hit5 / results.length,
    recallAt10: hit10 / results.length,
    avgNdcg5: results.reduce((s, r) => s + r.ndcg5, 0) / results.length,
    avgNdcg10: results.reduce((s, r) => s + r.ndcg10, 0) / results.length,
  };
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
