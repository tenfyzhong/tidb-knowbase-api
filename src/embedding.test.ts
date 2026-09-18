import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmbeddingProvider,
  HuggingFaceEmbeddingProvider,
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  TiDBAutoEmbeddingProvider
} from "./embedding.js";
import type { Env } from "./config.js";

describe("Embedding Providers (API)", () => {
  const baseEnv: Env = {
    API_TOKEN: "secret-token",
    TIDB_HOST: "localhost",
    TIDB_USER: "root",
    TIDB_DATABASE: "test",
    TIDB_PORT: 4000,
    TIDB_SSL: true,
    TIDB_SSL_REJECT_UNAUTHORIZED: true,
    PORT: 3000
  };

  describe("MockEmbeddingProvider", () => {
    it("generates deterministic unit-normalized embeddings of the requested dimension", async () => {
      const provider = new MockEmbeddingProvider(1024);
      expect(provider.dimension).toBe(1024);
      expect(provider.isAutoEmbedding).toBe(false);

      const results = await provider.embed(["Search query", "Search query"]);
      expect(results.length).toBe(2);
      expect(results[0].length).toBe(1024);
      expect(results[0]).toEqual(results[1]);

      const sumSq = results[0].reduce((acc, v) => acc + v * v, 0);
      expect(Math.abs(sumSq - 1)).toBeLessThan(0.01);
    });
  });

  describe("OpenAIEmbeddingProvider", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("embeds query text via OpenAI-compatible endpoint", async () => {
      const mockResponse = {
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }]
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: "sk-test",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "BAAI/bge-m3",
        dimension: 3
      });

      const results = await provider.embed(["query text"]);
      expect(results).toEqual([[0.1, 0.2, 0.3]]);
    });
  });
  describe("HuggingFaceEmbeddingProvider", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("calls HuggingFace router pipeline/feature-extraction endpoint with token and x-wait-for-model", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          [0.1, 0.2],
          [0.3, 0.4]
        ]
      });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const results = await provider.embed(["A", "B"]);
      expect(results).toEqual([
        [0.1, 0.2],
        [0.3, 0.4]
      ]);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer hf_test",
            "x-wait-for-model": "true"
          }),
          body: JSON.stringify({
            inputs: ["A", "B"],
            options: { wait_for_model: true }
          })
        })
      );
    });

    it("handles 3D array response (token-level embeddings) and applies mean pooling", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [
          [
            [1.0, 3.0],
            [3.0, 5.0]
          ]
        ]
      });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2
      });

      const results = await provider.embed(["Sentence to pool"]);
      expect(results).toEqual([[2.0, 4.0]]);
    });
    it("retries on 504 Gateway Time-out and succeeds on subsequent attempt", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: false,
          status: 504,
          statusText: "Gateway Time-out",
          text: async () => "<html><head><title>504 Gateway Time-out</title></head></html>"
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [[0.9, 0.8]]
        });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2,
        retryDelayMs: 1
      });

      const results = await provider.embed(["test text"]);
      expect(results).toEqual([[0.9, 0.8]]);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 503 model loading with estimated_time", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: async () => JSON.stringify({ error: "Model BAAI/bge-m3 is currently loading", estimated_time: 0.001 })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [[0.7, 0.6]]
        });

      const provider = new HuggingFaceEmbeddingProvider({
        token: "hf_test",
        model: "BAAI/bge-m3",
        dimension: 2,
        retryDelayMs: 1
      });

      const results = await provider.embed(["test text"]);
      expect(results).toEqual([[0.7, 0.6]]);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });


  describe("createEmbeddingProvider", () => {
    it("creates Mock provider when EMBEDDING_PROVIDER=mock", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_PROVIDER: "mock",
        EMBEDDING_DIMENSION: 512
      });
      expect(provider).toBeInstanceOf(MockEmbeddingProvider);
      expect(provider.dimension).toBe(512);
    });

    it("creates TiDBAuto provider when EMBEDDING_PROVIDER=tidb_auto", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_PROVIDER: "tidb_auto"
      });
      expect(provider).toBeInstanceOf(TiDBAutoEmbeddingProvider);
      expect(provider.isAutoEmbedding).toBe(true);
    });
  });
});
