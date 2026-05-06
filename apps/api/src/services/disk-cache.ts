import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Generic on-disk JSON cache with optional TTL. Each cache lives under its
 * own namespace directory (e.g. `.cache/llm`, `.cache/articles`).
 *
 * Disable a single namespace at runtime by setting the env var named in
 * `disableEnvVar` to "true". Override the parent directory with `LLM_CACHE_DIR`
 * etc. by passing `dirEnvVar`.
 *
 * Stored shape: `{ cachedAt: number, value: T }` so a TTL check is possible
 * without separate metadata files.
 */
export interface DiskCacheOptions {
  /** Subdirectory under `.cache/` — e.g. "llm", "articles". */
  namespace: string;
  /** Optional TTL in ms. `null`/omitted means "cache forever". */
  ttlMs?: number | null;
  /** Env var that disables the cache when set to "true". */
  disableEnvVar?: string;
  /** Env var that overrides the directory (full path). */
  dirEnvVar?: string;
}

interface Envelope<T> {
  cachedAt: number;
  value: T;
}

export class DiskCache<T> {
  private readonly options: DiskCacheOptions;

  constructor(options: DiskCacheOptions) {
    this.options = options;
  }

  isEnabled(): boolean {
    if (!this.options.disableEnvVar) return true;
    return process.env[this.options.disableEnvVar] !== "true";
  }

  /** Resolve the directory lazily so env overrides apply per-call. */
  private getDir(): string {
    const override = this.options.dirEnvVar
      ? process.env[this.options.dirEnvVar]
      : undefined;
    if (override) return resolve(override);
    return resolve(process.cwd(), ".cache", this.options.namespace);
  }

  /** Stable hash of a string or JSON-serializable object. */
  keyFor(input: string | Record<string, unknown>): string {
    const canonical = typeof input === "string" ? input : JSON.stringify(input);
    return createHash("sha256").update(canonical).digest("hex");
  }

  async get(key: string): Promise<T | null> {
    if (!this.isEnabled()) return null;
    const path = join(this.getDir(), `${key}.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Envelope<T>>;
      // Treat legacy/corrupt files (no envelope or missing value) as a miss
      // rather than returning undefined to the caller.
      if (!parsed || typeof parsed !== "object" || !("cachedAt" in parsed) || !("value" in parsed)) {
        return null;
      }
      if (this.options.ttlMs && Date.now() - (parsed.cachedAt as number) > this.options.ttlMs) {
        return null;
      }
      return (parsed.value as T) ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: T): Promise<void> {
    if (!this.isEnabled()) return;
    const dir = this.getDir();
    await mkdir(dir, { recursive: true });
    const envelope: Envelope<T> = { cachedAt: Date.now(), value };
    await writeFile(join(dir, `${key}.json`), JSON.stringify(envelope), "utf8");
  }

  /**
   * Cache-aside helper: hit returns the cached value; miss runs `compute`
   * and stores the result if `shouldCache` allows.
   */
  async with(
    keyInput: string | Record<string, unknown>,
    compute: () => Promise<T>,
    extras: {
      shouldCache?: (value: T) => boolean;
      onAttemptLog?: (message: string) => void;
    } = {},
  ): Promise<T> {
    const key = this.keyFor(keyInput);
    const cached = await this.get(key);
    if (cached !== null) {
      extras.onAttemptLog?.(
        `${this.options.namespace}-cache: hit (${key.slice(0, 12)})`,
      );
      return cached;
    }
    extras.onAttemptLog?.(
      `${this.options.namespace}-cache: miss (${key.slice(0, 12)})`,
    );
    const value = await compute();
    const shouldCache = extras.shouldCache ?? (() => true);
    if (shouldCache(value)) {
      await this.set(key, value);
    }
    return value;
  }
}
