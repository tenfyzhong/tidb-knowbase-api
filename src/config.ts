import { z } from "zod";

export const EnvSchema = z.object({
  // Deployment admin token
  API_TOKEN: z.string().min(1, "API_TOKEN is required"),

  // TiDB connection settings
  TIDB_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  TIDB_HOST: z.string().optional(),
  TIDB_PORT: z.coerce.number().int().default(4000),
  TIDB_USER: z.string().optional(),
  TIDB_PASSWORD: z.string().optional(),
  TIDB_DATABASE: z.string().default("test"),
  TIDB_SSL: z.preprocess((val) => {
    if (typeof val === "string") return val.toLowerCase() !== "false";
    return val ?? true;
  }, z.boolean()).default(true),

  // Embedding provider configuration
  EMBEDDING_PROVIDER: z.enum(["openai", "huggingface", "gemini", "mock"]).default("openai"),
  EMBEDDING_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  HF_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().default("https://api.siliconflow.cn/v1"),
  EMBEDDING_MODEL: z.string().default("BAAI/bge-m3"),
  EMBEDDING_DIMENSION: z.coerce.number().int().default(1024),

  // Server port
  PORT: z.coerce.number().int().default(3000)
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
