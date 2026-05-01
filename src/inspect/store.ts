import { randomUUID } from "node:crypto";
import type { InspectEvent, InspectEventStore, InspectEventType } from "./types.js";

const DEFAULT_CAPACITY = 500;

/**
 * In-memory ring-buffer implementation of InspectEventStore.
 * Retains the most recent `capacity` events.
 */
export class InMemoryInspectEventStore implements InspectEventStore {
  private readonly buffer: InspectEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  emit(event: Omit<InspectEvent, "id" | "timestamp">): InspectEvent {
    const full: InspectEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.buffer.push(full);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    return full;
  }

  recent(options?: { limit?: number; type?: InspectEventType }): InspectEvent[] {
    let events = [...this.buffer].reverse();
    if (options?.type) {
      events = events.filter((e) => e.type === options.type);
    }
    if (options?.limit && options.limit > 0) {
      events = events.slice(0, options.limit);
    }
    return events;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
