import { describe, expect, it } from "vitest";
import { parseEnv } from "./config.js";
import { resolveSslOptions } from "./db.js";

describe("config (API)", () => {
  it("parses valid env with TIDB_DATABASE_URL", () => {
    const rawEnv = {
      API_TOKEN: "secret-token",
      TIDB_DATABASE_URL: "mysql://user:pass@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test"
    };

    const env = parseEnv(rawEnv);
    expect(env.TIDB_DATABASE_URL).toBe(rawEnv.TIDB_DATABASE_URL);
    expect(env.API_TOKEN).toBe("secret-token");
    expect(env.EMBEDDING_PROVIDER).toBe("cloudflare");
  });

  it("safely handles empty strings from environment variables", () => {
    const rawEnv = {
      API_TOKEN: "secret-token",
      TIDB_DATABASE_URL: "mysql://user:pass@gateway.tidbcloud.com:4000/test",
      TIDB_HOST: "",
      TIDB_PORT: "",
      TIDB_USER: "",
      TIDB_PASSWORD: "",
      TIDB_DATABASE: "",
      EMBEDDING_PROVIDER: "",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "cf-acc",
      CLOUDFLARE_BASE_URL: "",
      CLOUDFLARE_MODEL: "",
      EMBEDDING_API_KEY: "",
      EMBEDDING_BASE_URL: "",
      EMBEDDING_MODEL: "",
      EMBEDDING_DIMENSION: "",
      AUTO_EMBEDDING_MODEL: "",
      AUTO_EMBEDDING_DIMENSION: ""
    };

    const env = parseEnv(rawEnv);
    expect(env.TIDB_HOST).toBeUndefined();
    expect(env.TIDB_PORT).toBe(4000);
    expect(env.TIDB_DATABASE).toBe("test");
    expect(env.EMBEDDING_PROVIDER).toBe("cloudflare");
    expect(env.EMBEDDING_DIMENSION).toBeUndefined();
    expect(env.AUTO_EMBEDDING_DIMENSION).toBeUndefined();
    expect(env.AUTO_EMBEDDING_MODEL).toBeUndefined();
  });

  it("configures TLS with minimum TLSv1.2 by default", () => {
    const env = parseEnv({
      API_TOKEN: "secret-token",
      TIDB_DATABASE_URL: "mysql://localhost/test"
    });
    const ssl = resolveSslOptions(env);
    expect(ssl).toEqual({
      minVersion: "TLSv1.2",
      rejectUnauthorized: true
    });
  });
});
