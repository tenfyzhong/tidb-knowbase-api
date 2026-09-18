import { z } from "zod";

const emptyToUndefined = (val: unknown) => {
  if (typeof val === "string" && val.trim() === "") {
    return undefined;
  }
  return val;
};

export const EnvSchema = z.object({
  // Deployment admin token
  API_TOKEN: z.string().min(1, "API_TOKEN is required"),

  // TiDB connection settings
  TIDB_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  TIDB_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  TIDB_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(4000)),
  TIDB_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  TIDB_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  TIDB_DATABASE: z.preprocess(emptyToUndefined, z.string().default("test")),
  TIDB_SSL: z.preprocess((val) => {
    if (typeof val === "string") {
      if (val.trim() === "") return true;
      return val.toLowerCase() !== "false";
    }
    return val ?? true;
  }, z.boolean()).default(true),
  TIDB_SSL_REJECT_UNAUTHORIZED: z.preprocess((val) => {
    if (typeof val === "string") {
      if (val.trim() === "") return true;
      return val.toLowerCase() !== "false";
    }
    return val ?? true;
  }, z.boolean()).default(true),
  TIDB_CA: z.preprocess(emptyToUndefined, z.string().optional()),
  // Embedding settings
  EMBEDDING_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(["cloudflare", "cf", "tidb_auto", "auto", "mock"]).default("cloudflare")
  ),
  CLOUDFLARE_API_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_BASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  EMBEDDING_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  EMBEDDING_BASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  EMBEDDING_DIMENSION: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  AUTO_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  AUTO_EMBEDDING_DIMENSION: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  // Server port
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3000))
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(rawEnv: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }

  const env = result.data;
  const hasDbUrl = Boolean(env.TIDB_DATABASE_URL || env.DATABASE_URL);
  const hasDbHost = Boolean(env.TIDB_HOST && env.TIDB_USER);

  if (!hasDbUrl && !hasDbHost) {
    throw new Error(
      "Missing database connection settings. Please provide TIDB_DATABASE_URL (or DATABASE_URL), or TIDB_HOST and TIDB_USER."
    );
  }

  return env;
}
