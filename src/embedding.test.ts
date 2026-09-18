import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createEmbeddingProvider,
  CloudflareEmbeddingProvider,
  MockEmbeddingProvider,
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

  describe("CloudflareEmbeddingProvider", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("embeds query text via Cloudflare endpoint", async () => {
      const mockResponse = {
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }]
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const provider = new CloudflareEmbeddingProvider({
        accountId: "my-cf-acc",
        apiToken: "cf-token",
        model: "@cf/baai/bge-m3",
        dimension: 3
      });

      const results = await provider.embed(["query text"]);
      expect(results).toEqual([[0.1, 0.2, 0.3]]);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/my-cf-acc/ai/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer cf-token"
          })
        })
      );
    });

    it("parses Cloudflare direct run response format ({ result: { data: [...] } })", async () => {
      const mockRunResponse = {
        result: {
          data: [[0.5, 0.6, 0.7]]
        },
        success: true
      };

      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockRunResponse
      });

      const provider = new CloudflareEmbeddingProvider({
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/my-cf-acc/ai/run/@cf/baai/bge-m3",
        apiToken: "cf-token",
        dimension: 3
      });

      const results = await provider.embed(["query text"]);
      expect(results).toEqual([[0.5, 0.6, 0.7]]);
    });

    it("retries on 429 and 500 status codes with backoff and succeeds", async () => {
      (global.fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          text: async () => "Rate limited"
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ index: 0, embedding: [0.9, 0.8] }]
          })
        });

      const provider = new CloudflareEmbeddingProvider({
        accountId: "my-cf-acc",
        apiToken: "cf-token",
        dimension: 2,
        retryDelayMs: 1
      });

      const results = await provider.embed(["query text"]);
      expect(results).toEqual([[0.9, 0.8]]);
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

    it("defaults to Cloudflare provider when CLOUDFLARE_API_TOKEN is provided", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        CLOUDFLARE_API_TOKEN: "cf-token",
        CLOUDFLARE_ACCOUNT_ID: "acc-id"
      });
      expect(provider).toBeInstanceOf(CloudflareEmbeddingProvider);
      expect(provider.model).toBe("@cf/baai/bge-m3");
    });

    it("creates Cloudflare provider when EMBEDDING_PROVIDER=cloudflare or cf", () => {
      const provider = createEmbeddingProvider({
        ...baseEnv,
        EMBEDDING_PROVIDER: "cloudflare",
        CLOUDFLARE_ACCOUNT_ID: "acc-id"
      });
      expect(provider).toBeInstanceOf(CloudflareEmbeddingProvider);
    });
  });
});
