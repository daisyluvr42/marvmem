import type { InspectEvent, InspectEventStore, InspectEventType } from "./types.js";

export type WebhookTarget = {
  url: string;
  events?: InspectEventType[];
  headers?: Record<string, string>;
};

export class WebhookDispatcher {
  constructor(private readonly targets: WebhookTarget[]) {}

  dispatch(event: InspectEvent): void {
    for (const target of this.targets) {
      if (target.events && !target.events.includes(event.type)) {
        continue;
      }
      void fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(target.headers ?? {}),
        },
        body: JSON.stringify(event),
      }).catch(() => {});
    }
  }
}

export class DispatchingInspectEventStore implements InspectEventStore {
  constructor(
    private readonly store: InspectEventStore,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  emit(event: Omit<InspectEvent, "id" | "timestamp">): InspectEvent {
    const full = this.store.emit(event);
    this.dispatcher.dispatch(full);
    return full;
  }

  recent(options?: { limit?: number; type?: InspectEventType }): InspectEvent[] {
    return this.store.recent(options);
  }

  clear(): void {
    this.store.clear();
  }
}
