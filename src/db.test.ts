import { describe, it, expect, vi, beforeEach } from "vitest";
import mysql from "mysql2/promise";
import { resolveSslOptions, TiDBClient } from "./db.js";
import { MockEmbeddingProvider, TiDBAutoEmbeddingProvider } from "./embedding.js";
import type { Env } from "./config.js";

vi.mock("mysql2/promise");

describe("db (API)", () => {
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

  describe("resolveSslOptions", () => {
    it("returns undefined when TIDB_SSL is false", () => {
      expect(resolveSslOptions({ ...baseEnv, TIDB_SSL: false })).toBeUndefined();
    });

    it("returns rejectUnauthorized option by default", () => {
      const ssl = resolveSslOptions(baseEnv);
      expect(ssl?.rejectUnauthorized).toBe(true);
    });
  });

  describe("TiDBClient search & schema", () => {
    let mockPool: {
      query: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockPool = {
        query: vi.fn(),
        end: vi.fn()
      };
      (mysql.createPool as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPool);
    });

    it("searches with VEC_COSINE_DISTANCE(embedding, VEC_FROM_TEXT(?)) in client-side mode", async () => {
      const mockProvider = new MockEmbeddingProvider(1024);
      const client = new TiDBClient(baseEnv, mockProvider);

      mockPool.query.mockResolvedValueOnce([
        [
          {
            id: "1",
            text: "Result text",
            source: "docs",
            path: "test.md",
            title: "Test",
            chunkIndex: 0,
            url: "https://example.com",
            distance: 0.2
          }
        ]
      ]);

      const results = await client.search("hello world", { topK: 3 });

      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0.9);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("VEC_COSINE_DISTANCE(embedding, VEC_FROM_TEXT(?)) AS distance"),
        expect.anything()
      );
    });

    it("searches with VEC_EMBED_COSINE_DISTANCE in auto-embedding mode", async () => {
      const autoProvider = new TiDBAutoEmbeddingProvider();
      const client = new TiDBClient(baseEnv, autoProvider);

      mockPool.query.mockResolvedValueOnce([
        [
          {
            id: "1",
            text: "Result text",
            source: "docs",
            path: "test.md",
            chunkIndex: 0,
            distance: 0.4
          }
        ]
      ]);

      const results = await client.search("hello world", { topK: 3 });

      expect(results.length).toBe(1);
      expect(results[0].score).toBe(0.8);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("VEC_EMBED_COSINE_DISTANCE(embedding, ?) AS distance"),
        expect.arrayContaining(["hello world"])
      );
    });

    it("creates chunks table with VECTOR(dim) NOT NULL when using client-side embedding", async () => {
      const mockProvider = new MockEmbeddingProvider(1024);
      const client = new TiDBClient(baseEnv, mockProvider);

      mockPool.query.mockResolvedValueOnce([[]]); // INFORMATION_SCHEMA
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE chunks
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE sync_state

      await client.initSchema();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("embedding VECTOR(1024) NOT NULL")
      );
    });

    it("drops legacy table when switching between auto and client-side vector mode", async () => {
      const mockProvider = new MockEmbeddingProvider(1024);
      const client = new TiDBClient(baseEnv, mockProvider);

      mockPool.query.mockResolvedValueOnce([
        [{ EXTRA: "STORED GENERATED", GENERATION_EXPRESSION: 'EMBED_TEXT("...", text)' }]
      ]);
      mockPool.query.mockResolvedValueOnce([{}]); // DROP TABLE
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE chunks
      mockPool.query.mockResolvedValueOnce([{}]); // CREATE TABLE sync_state

      await client.initSchema();

      expect(mockPool.query).toHaveBeenCalledWith("DROP TABLE IF EXISTS chunks");
    });
  });
});
