import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord, MemoryStore } from "./types.js";

function cloneRecords(records: MemoryRecord[]): MemoryRecord[] {
  return records.map((record) => ({
    ...record,
    scope: { ...record.scope },
    tags: [...record.tags],
    metadata: record.metadata ? { ...record.metadata } : undefined,
  }));
}

export class FileMemoryStore implements MemoryStore {
  private cache: MemoryRecord[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryRecord[]> {
    if (this.cache) {
      return cloneRecords(this.cache);
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MemoryRecord[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = [];
      } else {
        throw error;
      }
    }
    return cloneRecords(this.cache);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    this.cache = cloneRecords(records);
    // Serialize writes so concurrent save() calls don't interleave I/O
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
    });
    await this.writeQueue;
  }
}

export class InMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async load(): Promise<MemoryRecord[]> {
    return cloneRecords(this.records);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    this.records = cloneRecords(records);
  }
}
