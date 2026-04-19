/**
 * Reporter: format results as tables and write JSONL.
 */
import { writeFileSync, appendFileSync } from "node:fs";
import type { BenchResult, CategoryStats } from "./metrics.js";

export function writeResultsJsonl(results: BenchResult[], outputPath: string): void {
  const lines = results.map(r => JSON.stringify(r));
  writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
}

export function appendResultJsonl(result: BenchResult, outputPath: string): void {
  appendFileSync(outputPath, JSON.stringify(result) + "\n", "utf-8");
}

export function printCategoryTable(
  categories: Map<string, CategoryStats>,
  overall: CategoryStats,
): void {
  console.log("\n┌─────────────────────────────┬───────┬─────────┬─────────┬──────────┬──────────┐");
  console.log("│ Category                    │ Count │  R@5    │  R@10   │ NDCG@5   │ NDCG@10  │");
  console.log("├─────────────────────────────┼───────┼─────────┼─────────┼──────────┼──────────┤");

  const sorted = [...categories.entries()].sort((a, b) => b[1].recallAt5 - a[1].recallAt5);
  for (const [, stats] of sorted) {
    console.log(
      `│ ${stats.category.padEnd(27)} │ ${String(stats.total).padStart(5)} │ ${pct(stats.recallAt5)} │ ${pct(stats.recallAt10)} │ ${f3(stats.avgNdcg5)} │ ${f3(stats.avgNdcg10)} │`,
    );
  }

  console.log("├─────────────────────────────┼───────┼─────────┼─────────┼──────────┼──────────┤");
  console.log(
    `│ ${"OVERALL".padEnd(27)} │ ${String(overall.total).padStart(5)} │ ${pct(overall.recallAt5)} │ ${pct(overall.recallAt10)} │ ${f3(overall.avgNdcg5)} │ ${f3(overall.avgNdcg10)} │`,
  );
  console.log("└─────────────────────────────┴───────┴─────────┴─────────┴──────────┴──────────┘");
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`.padStart(7);
}

function f3(v: number): string {
  return v.toFixed(3).padStart(8);
}

export function printSummary(overall: CategoryStats, mode: string, elapsedTotalMs: number): void {
  console.log(`\n━━━ MarvMem LongMemEval Benchmark ━━━`);
  console.log(`Mode:      ${mode}`);
  console.log(`Questions: ${overall.total}`);
  console.log(`R@5:       ${(overall.recallAt5 * 100).toFixed(1)}% (${overall.hitAt5}/${overall.total})`);
  console.log(`R@10:      ${(overall.recallAt10 * 100).toFixed(1)}% (${overall.hitAt10}/${overall.total})`);
  console.log(`NDCG@5:    ${overall.avgNdcg5.toFixed(3)}`);
  console.log(`NDCG@10:   ${overall.avgNdcg10.toFixed(3)}`);
  console.log(`Time:      ${(elapsedTotalMs / 1000).toFixed(1)}s (${(elapsedTotalMs / overall.total).toFixed(0)}ms/q)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}
