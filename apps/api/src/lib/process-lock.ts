import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

/**
 * Single-instance process lock backed by an exclusive lockfile.
 *
 * Acquires `.locks/<name>.lock` via O_EXCL. If the file already exists, reads
 * the PID inside and decides:
 *   - PID is still alive on this host: throw — another run is in progress.
 *   - PID is dead, or the file is malformed: stale lock, take it over.
 *
 * The lock is released on normal exit and on SIGINT/SIGTERM. We deliberately
 * do not try to handle SIGKILL or hard crashes — the staleness check on next
 * acquire covers that case.
 */

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  cmd: string;
}

export class ProcessLockError extends Error {
  constructor(
    message: string,
    readonly holder: LockInfo,
  ) {
    super(message);
    this.name = "ProcessLockError";
  }
}

function lockDir(): string {
  return resolve(process.cwd(), ".locks");
}

function readLockFile(path: string): LockInfo | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== "number" || !parsed.host) return null;
    return {
      pid: parsed.pid,
      host: parsed.host,
      startedAt: parsed.startedAt ?? "",
      cmd: parsed.cmd ?? "",
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — just probes existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still alive.
    return code === "EPERM";
  }
}

/**
 * Acquire an exclusive lock named `name`. Throws ProcessLockError if another
 * live process holds it. Returns a release function; releasing is idempotent.
 */
export function acquireProcessLock(name: string): () => void {
  const dir = lockDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.lock`);

  const tryCreate = (): number | null => {
    try {
      return openSync(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
  };

  let fd = tryCreate();
  if (fd === null) {
    const existing = readLockFile(path);
    const sameHost = existing?.host === hostname();
    if (existing && sameHost && isProcessAlive(existing.pid)) {
      throw new ProcessLockError(
        `Lock "${name}" held by pid ${existing.pid} on ${existing.host} since ${existing.startedAt}`,
        existing,
      );
    }
    // Stale (dead PID, malformed, or different host we can't probe). Reclaim.
    try {
      unlinkSync(path);
    } catch {
      // Race with another reclaimer: fall through to the second create attempt.
    }
    fd = tryCreate();
    if (fd === null) {
      // Someone else won the race; treat as held.
      const winner = readLockFile(path);
      throw new ProcessLockError(
        `Lock "${name}" was reclaimed by another process while we were waiting`,
        winner ?? { pid: -1, host: "?", startedAt: "", cmd: "" },
      );
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    cmd: process.argv.slice(1).join(" "),
  };
  writeSync(fd, JSON.stringify(info, null, 2));
  closeSync(fd);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only remove the file if it still belongs to us — guards against the
      // case where a stale-takeover replaced our entry.
      const current = readLockFile(path);
      if (current && current.pid === process.pid && current.host === hostname()) {
        unlinkSync(path);
      }
    } catch {
      // best-effort
    }
  };

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return release;
}
