import { embedTextHash } from "../core/hash-embedding.js";
import type { MemoryEmbeddingProviderConfig } from "../system/types.js";
import type { EmbeddingVector, MemoryEmbeddingProvider } from "./types.js";

const DEFAULT_HASH_DIMENSIONS = 128;

export async function createEmbeddingProvider(
  config?: MemoryEmbeddingProviderConfig,
): Promise<MemoryEmbeddingProvider | null> {
  const providerId = resolveProviderId(config);
  if (!providerId) {
    return null;
  }
  if (providerId === "script") {
    throw new Error("Script embedding provider is not supported in marvmem");
  }
  if (providerId === "openai") {
    return new OpenAiEmbeddingProvider(config);
  }
  if (providerId === "gemini") {
    return new GeminiEmbeddingProvider(config);
  }
  return new VoyageEmbeddingProvider(config);
}

export class HashEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "hash";

  constructor(private readonly dimensions: number = DEFAULT_HASH_DIMENSIONS) {}

  async embedQuery(text: string): Promise<EmbeddingVector> {
    return embedTextHash(text, this.dimensions);
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    return texts.map((text) => embedTextHash(text, this.dimensions));
  }
}

function resolveProviderId(
  config?: MemoryEmbeddingProviderConfig,
): "openai" | "gemini" | "voyage" | "script" | null {
  const provider = config?.provider ?? "auto";
  if (provider !== "auto") {
    return provider;
  }
  if (config?.remote?.apiKey || process.env.OPENAI_API_KEY) {
    return "openai";
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return "gemini";
  }
  if (process.env.VOYAGE_API_KEY) {
    return "voyage";
  }
  return null;
}

class OpenAiEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "openai";
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config?: MemoryEmbeddingProviderConfig) {
    this.model = config?.model ?? "text-embedding-3-small";
    this.dimensions = config?.dimensions;
    this.apiKey = config?.remote?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (config?.remote?.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
    this.headers = config?.remote?.headers ?? {};
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    return (await this.embedDocuments([text]))[0] ?? [];
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI embedding provider");
    }
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
        encoding_format: "float",
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI embeddings request failed with ${response.status}`);
    }
    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    return (data.data ?? []).map((item) => item.embedding ?? []);
  }
}

class GeminiEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "gemini";
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config?: MemoryEmbeddingProviderConfig) {
    this.model = config?.model ?? "gemini-embedding-001";
    this.dimensions = config?.dimensions;
    this.apiKey =
      config?.remote?.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
    this.baseUrl = (
      config?.remote?.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
    this.headers = config?.remote?.headers ?? {};
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    return (await this.embed("RETRIEVAL_QUERY", [text]))[0] ?? [];
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    return await this.embed("RETRIEVAL_DOCUMENT", texts);
  }

  private async embed(
    taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT",
    texts: string[],
  ): Promise<EmbeddingVector[]> {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is required for the Gemini embedding provider");
    }
    const requests = texts.map((text) => ({
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: this.dimensions,
    }));
    const response = await fetch(`${this.baseUrl}/models/${this.model}:batchEmbedContents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
        ...this.headers,
      },
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
      throw new Error(`Gemini embeddings request failed with ${response.status}`);
    }
    const data = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    return (data.embeddings ?? []).map((entry) => entry.values ?? []);
  }
}

class VoyageEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly id = "voyage";
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config?: MemoryEmbeddingProviderConfig) {
    this.model = config?.model ?? "voyage-4";
    this.dimensions = config?.dimensions;
    this.apiKey = config?.remote?.apiKey ?? process.env.VOYAGE_API_KEY ?? "";
    this.baseUrl = (config?.remote?.baseUrl ?? "https://api.voyageai.com").replace(/\/+$/, "");
    this.headers = config?.remote?.headers ?? {};
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    return (await this.embed("query", [text]))[0] ?? [];
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    return await this.embed("document", texts);
  }

  private async embed(inputType: "query" | "document", texts: string[]): Promise<EmbeddingVector[]> {
    if (!this.apiKey) {
      throw new Error("VOYAGE_API_KEY is required for the Voyage embedding provider");
    }
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
      }),
    });
    if (!response.ok) {
      throw new Error(`Voyage embeddings request failed with ${response.status}`);
    }
    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    return (data.data ?? []).map((item) => item.embedding ?? []);
  }
}
