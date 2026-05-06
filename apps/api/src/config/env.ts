import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), "../../../.env"),
]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4400),
  HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:5317"),
  APP_DATE_TIMEZONE: z.string().default("UTC"),
  KAGI_KITE_URL: z
    .string()
    .url()
    .default("https://raw.githubusercontent.com/kagisearch/kite-public/main/kite_feeds.json"),
  AUTO_INGEST: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  AUTO_INGEST_TIME_UTC: z.string().default("12:30"),
  RSS_FETCH_TIMEOUT_MS: z.coerce.number().default(10000),
  ARTICLE_FETCH_TIMEOUT_MS: z.coerce.number().default(15000),
  ARTICLE_FETCH_USER_AGENT: z
    .string()
    .default("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"),
  ARTICLE_BROWSER_TIMEOUT_MS: z.coerce.number().default(30000),
  INGEST_FEED_LIMIT: z.coerce.number().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_MODEL_OFFSET: z.coerce.number().int().default(0),
  // Direct OpenAI fallback used when every OpenRouter free model is exhausted.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_FALLBACK_MODEL: z.string().default("gpt-5.4-nano"),
  PERSPECTIVE_SIDECAR_URL: z.string().url().default("http://127.0.0.1:5710"),
  PERSPECTIVE_SIDECAR_TIMEOUT_MS: z.coerce.number().int().default(120000),
});

export const env = envSchema.parse(process.env);
