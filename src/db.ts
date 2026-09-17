import mysql from "mysql2/promise";
import type { Env } from "./config.js";

export interface SearchResultItem {
  id: string;
  score: number;
  text: string;
  source: string;
  path: string;
  title?: string;
  chunkIndex: number;
  url?: string;
}

export interface ChunkItem {
  id: string;
  text: string;
  source: string;
  path: string;
  title?: string;
  chunkIndex: number;
  url?: string;
  embedding?: number[];
}

export interface SyncStateItem {
  hash: string;
  chunkCount: number;
  isConfidential?: boolean;
}

export interface SyncState {
  lastCommit?: string;
  files: Record<string, SyncStateItem>;
}

export function resolveSslOptions(env: Env): mysql.SslOptions | undefined {
  if (env.TIDB_SSL === false) {
    return undefined;
  }

  const ssl: mysql.SslOptions = {
    minVersion: "TLSv1.2",
    rejectUnauthorized: env.TIDB_SSL_REJECT_UNAUTHORIZED !== false
  };

  if (env.TIDB_CA) {
    ssl.ca = env.TIDB_CA;
  }

  return ssl;
}

export class TiDBClient {
  private pool: mysql.Pool;
  private readonly dimension: number;

  constructor(env: Env) {
    this.dimension = env.EMBEDDING_DIMENSION || 1024;
    const dbUrl = env.TIDB_DATABASE_URL || env.DATABASE_URL;
    const ssl = resolveSslOptions(env);

    if (dbUrl) {
      this.pool = mysql.createPool({
        uri: dbUrl,
        ssl,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
      });
    } else {
      this.pool = mysql.createPool({
        host: env.TIDB_HOST,
        port: env.TIDB_PORT || 4000,
        user: env.TIDB_USER,
        password: env.TIDB_PASSWORD,
        database: env.TIDB_DATABASE || "test",
        ssl,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
      });
    }
  }

  async initSchema(dimension = this.dimension): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id VARCHAR(255) PRIMARY KEY,
        text MEDIUMTEXT NOT NULL,
        source VARCHAR(128) NOT NULL,
        path VARCHAR(512) NOT NULL,
        title VARCHAR(255),
        chunk_index INT NOT NULL DEFAULT 0,
        url VARCHAR(1024),
        embedding VECTOR(${dimension}) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_source (source),
        INDEX idx_path (path)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sync_state (
        source VARCHAR(128) PRIMARY KEY,
        state JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);
  }

  async search(
    queryVector: number[],
    options: { topK?: number; source?: string } = {}
  ): Promise<SearchResultItem[]> {
    const topK = Math.min(Math.max(options.topK || 5, 1), 50);
    const vectorJson = JSON.stringify(queryVector);

    let sql = `
      SELECT
        id,
        text,
        source,
        path,
        title,
        chunk_index AS chunkIndex,
        url,
        VEC_COSINE_DISTANCE(embedding, VEC_FROM_TEXT(?)) AS distance
      FROM chunks
    `;
    const params: unknown[] = [vectorJson];

    if (options.source) {
      sql += " WHERE source = ?";
      params.push(options.source);
    }

    sql += " ORDER BY distance ASC LIMIT ?";
    params.push(topK);

    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);

    return rows.map((row) => {
      const distance = typeof row.distance === "number" ? row.distance : Number(row.distance || 0);
      // Cosine distance ranges [0, 2]; convert to similarity score in [0, 1]
      const score = Math.max(0, Number((1 - distance / 2).toFixed(4)));

      return {
        id: String(row.id),
        score,
        text: String(row.text || ""),
        source: String(row.source || ""),
        path: String(row.path || ""),
        title: row.title ? String(row.title) : undefined,
        chunkIndex: Number(row.chunkIndex || 0),
        url: row.url ? String(row.url) : undefined
      };
    });
  }

  async upsertChunks(chunks: Array<ChunkItem & { embedding: number[] }>): Promise<number> {
    if (chunks.length === 0) return 0;

    const batchSize = 50;
    let totalUpserted = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const valuesPlaceholders: string[] = [];
      const queryParams: unknown[] = [];

      for (const item of batch) {
        valuesPlaceholders.push("(?, ?, ?, ?, ?, ?, ?, VEC_FROM_TEXT(?))");
        queryParams.push(
          item.id,
          item.text,
          item.source,
          item.path,
          item.title ?? null,
          item.chunkIndex,
          item.url ?? null,
          JSON.stringify(item.embedding)
        );
      }

      const sql = `
        INSERT INTO chunks (id, text, source, path, title, chunk_index, url, embedding)
        VALUES ${valuesPlaceholders.join(", ")}
        ON DUPLICATE KEY UPDATE
          text = VALUES(text),
          source = VALUES(source),
          path = VALUES(path),
          title = VALUES(title),
          chunk_index = VALUES(chunk_index),
          url = VALUES(url),
          embedding = VALUES(embedding),
          updated_at = CURRENT_TIMESTAMP
      `;

      await this.pool.query(sql, queryParams);
      totalUpserted += batch.length;
    }

    return totalUpserted;
  }

  async deleteChunks(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const batchSize = 100;
    let totalDeleted = 0;

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `DELETE FROM chunks WHERE id IN (${placeholders})`,
        batch
      );
      totalDeleted += result.affectedRows;
    }

    return totalDeleted;
  }

  async clearChunks(source?: string): Promise<{ deletedChunks: number; deletedState: boolean }> {
    if (source) {
      const [chunkRes] = await this.pool.query<mysql.ResultSetHeader>(
        "DELETE FROM chunks WHERE source = ?",
        [source]
      );
      const [stateRes] = await this.pool.query<mysql.ResultSetHeader>(
        "DELETE FROM sync_state WHERE source = ?",
        [source]
      );
      return {
        deletedChunks: chunkRes.affectedRows,
        deletedState: stateRes.affectedRows > 0
      };
    }

    const [chunkRes] = await this.pool.query<mysql.ResultSetHeader>("DELETE FROM chunks");
    const [stateRes] = await this.pool.query<mysql.ResultSetHeader>("DELETE FROM sync_state");

    return {
      deletedChunks: chunkRes.affectedRows,
      deletedState: stateRes.affectedRows > 0
    };
  }

  async getSyncState(source: string): Promise<SyncState | null> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      "SELECT state FROM sync_state WHERE source = ?",
      [source]
    );

    if (rows.length === 0 || !rows[0].state) {
      return null;
    }

    const raw = rows[0].state;
    return typeof raw === "string" ? JSON.parse(raw) : (raw as SyncState);
  }

  async saveSyncState(source: string, state: SyncState): Promise<void> {
    const jsonState = JSON.stringify(state);
    await this.pool.query(
      `INSERT INTO sync_state (source, state)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = CURRENT_TIMESTAMP`,
      [source, jsonState]
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
