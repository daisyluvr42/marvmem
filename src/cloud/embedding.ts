// ---------------------------------------------------------------------------
// Cloud Embedding Provider
// ---------------------------------------------------------------------------

/**
 * Proxies embedding requests through MarvMem Cloud.
 * Users don't need their own API key — the cloud service
 * uses a managed key and tracks usage against their plan.
 *
 * Falls back to a local provider if cloud is unavailable.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export type CloudEmbeddingConfig = {
  /** Cloud API endpoint, e.g. "https://api.marvmem.com" */
  apiUrl: string;
  /** User's cloud access token (JWT) */
  accessToken: string;
  /** Model to use (default: text-embedding-3-small) */
  model?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
};

export class CloudEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536; // text-embedding-3-small default
  private readonly config: Required<CloudEmbeddingConfig>;

  constructor(config: CloudEmbeddingConfig) {
    this.config = {
      model: "text-embedding-3-small",
      timeoutMs: 30_000,
      ...config,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const res = await fetch(`${this.config.apiUrl}/v1/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.accessToken}`,
        },
        body: JSON.stringify({
          texts,
          model: this.config.model,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Cloud embedding failed (${res.status}): ${body}`,
        );
      }

      const data = (await res.json()) as {
        embeddings: number[][];
        usage?: { tokens: number };
      };

      return data.embeddings;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// FallbackEmbeddingProvider
// ---------------------------------------------------------------------------

/**
 * Tries primary provider first, falls back to secondary on error.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(
    private readonly primary: EmbeddingProvider,
    private readonly fallback: EmbeddingProvider,
  ) {
    this.dimensions = primary.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      return await this.primary.embed(texts);
    } catch {
      return await this.fallback.embed(texts);
    }
  }
}
