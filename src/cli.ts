#!/usr/bin/env node
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_DB = "./ghq-commits.db";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 90 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CLONE_DIR = "./.ghq-commits/repos";

const SKIP_PATH_PARTS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);

type Args = { _: string[]; [key: string]: string | boolean | string[] };
type ItemRow = {
  id: number;
  repo: string;
  path: string;
  blob_sha: string;
  status: string;
  dirty: number;
  attempts: number;
  first_seen_commit: string;
  last_seen_commit: string;
  last_seen_commit_at: string;
  last_seen_at: string;
  delivered_at: string | null;
  lease_until: string | null;
  worker_id: string | null;
  reviewed_at: string | null;
  issue_number: number | null;
  issue_url: string | null;
  finding_severity: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type EnqueueInput = {
  repo: string;
  path: string;
  blobSha: string;
  commitSha: string;
  commitAt: string;
};

type GitChangedFile = {
  path: string;
  status: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    const next = argv[i + 1];
    const value = eq !== -1 ? arg.slice(eq + 1) : next && !next.startsWith("--") ? argv[++i] : true;
    if (args[key] === undefined) args[key] = value;
    else args[key] = Array.isArray(args[key]) ? [...args[key] as string[], String(value)] : [String(args[key]), String(value)];
  }
  return args;
}

function asString(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || value == null) return fallback;
  if (Array.isArray(value)) return value[value.length - 1];
  return String(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMsIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function parseDurationMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  return fallbackMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listArg(args: Args, name: string): string[] {
  const raw = args[name];
  const values = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return values.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
}

function normalizeExt(ext: string): string {
  const trimmed = ext.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

function onlyExts(args: Args): Set<string> {
  return new Set(listArg(args, "only").map(normalizeExt).filter(Boolean));
}

function excludedPath(path: string): boolean {
  return path.split("/").some((part) => SKIP_PATH_PARTS.has(part));
}

function pathExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx).toLowerCase() : "";
}

function pathAllowed(path: string, allowedExts: Set<string>): boolean {
  if (excludedPath(path)) return false;
  if (!allowedExts.size) return true;
  return allowedExts.has(pathExt(path));
}

function openDb(args: Args): Database.Database {
  const db = new Database(resolve(asString(args.db, DEFAULT_DB)!));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      blob_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dirty INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_seen_commit TEXT NOT NULL,
      last_seen_commit TEXT NOT NULL,
      last_seen_commit_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      delivered_at TEXT,
      lease_until TEXT,
      worker_id TEXT,
      reviewed_at TEXT,
      issue_number INTEGER,
      issue_url TEXT,
      finding_severity TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo, path)
    );
    CREATE INDEX IF NOT EXISTS idx_files_status_created ON files(status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_files_repo_blob ON files(repo, blob_sha);
    CREATE INDEX IF NOT EXISTS idx_files_lease ON files(status, lease_until);
  `);
  return db;
}

function getState(db: Database.Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function setState(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, value, nowIso());
}

async function execGit(cwd: string | undefined, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 100 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  return execGit(cwd, args, allowFailure);
}

async function gitRequired(cwd: string, args: string[]): Promise<string> {
  const out = await git(cwd, args);
  if (!out) throw new Error(`git ${args.join(" ")} returned empty output`);
  return out;
}

function parseRepoFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  let match = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  if (match) return match[1];
  match = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (match) return match[1];
  match = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/);
  return match ? match[1] : null;
}

async function repoName(args: Args, repoPath: string, remote: string): Promise<string> {
  const explicit = asString(args.repo);
  if (explicit) return explicit;
  const url = await gitRequired(repoPath, ["remote", "get-url", remote]);
  const parsed = parseRepoFromRemote(url);
  if (!parsed) throw new Error(`Could not derive owner/repo from remote URL: ${url}. Pass --repo owner/name.`);
  return parsed;
}

function repoSlug(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "__");
}

function repoCloneUrl(args: Args, repo: string): string {
  const explicit = asString(args["clone-url"]);
  if (explicit) return explicit;
  return `git@github.com:${repo}.git`;
}

async function managedRepoPath(args: Args): Promise<string> {
  const explicitPath = asString(args["repo-path"]);
  if (explicitPath) return resolve(explicitPath);

  const repo = asString(args.repo);
  if (!repo) throw new Error("sync/watch requires --repo owner/name when --repo-path is omitted");

  const cloneRoot = resolve(asString(args["clone-dir"], DEFAULT_CLONE_DIR)!);
  const repoPath = resolve(cloneRoot, repoSlug(repo));
  if (existsSync(resolve(repoPath, ".git"))) return repoPath;

  await mkdir(dirname(repoPath), { recursive: true });
  await execGit(undefined, ["clone", repoCloneUrl(args, repo), repoPath]);
  return repoPath;
}

function parseNameStatusZ(output: string): GitChangedFile[] {
  const parts = output.split("\0").filter(Boolean);
  const files: GitChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const code = status[0];
    if (code === "R" || code === "C") {
      i++; // old path
      const newPath = parts[i++];
      if (newPath) files.push({ status, path: newPath });
    } else {
      const path = parts[i++];
      if (path) files.push({ status, path });
    }
  }
  return files;
}

async function changedFiles(repoPath: string, base: string, head: string): Promise<GitChangedFile[]> {
  const output = await git(repoPath, ["diff", "--name-status", "-z", "--diff-filter=ACMR", "-M", `${base}..${head}`]);
  return parseNameStatusZ(output);
}

async function blobSha(repoPath: string, ref: string, path: string): Promise<string | null> {
  const out = await git(repoPath, ["rev-parse", `${ref}:${path}`], true);
  return out || null;
}

async function fileLastCommit(repoPath: string, ref: string, path: string): Promise<{ sha: string; at: string }> {
  const out = await gitRequired(repoPath, ["log", "-1", "--format=%H%x00%cI", ref, "--", path]);
  const [sha, at] = out.split("\0");
  return { sha, at: at || nowIso() };
}

async function currentFiles(repoPath: string, ref: string): Promise<GitChangedFile[]> {
  const output = await git(repoPath, ["ls-tree", "-r", "-z", "--name-only", ref]);
  return output.split("\0").filter(Boolean).map((path) => ({ status: "current", path }));
}

function enqueueFile(db: Database.Database, input: EnqueueInput): "inserted" | "updated" | "unchanged" {
  const ts = nowIso();
  const existing = db.prepare("SELECT blob_sha, status FROM files WHERE repo=? AND path=?").get(input.repo, input.path) as { blob_sha: string; status: string } | undefined;
  if (!existing) {
    db.prepare(`INSERT INTO files(repo, path, blob_sha, status, dirty, attempts, first_seen_commit, last_seen_commit, last_seen_commit_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?, ?, ?)`)
      .run(input.repo, input.path, input.blobSha, input.commitSha, input.commitSha, input.commitAt, ts, ts, ts);
    return "inserted";
  }

  if (existing.blob_sha === input.blobSha) {
    db.prepare("UPDATE files SET last_seen_commit=?, last_seen_commit_at=?, last_seen_at=?, updated_at=? WHERE repo=? AND path=?")
      .run(input.commitSha, input.commitAt, ts, ts, input.repo, input.path);
    return "unchanged";
  }

  const dirty = existing.status === "delivered" ? 1 : 0;
  const nextStatus = existing.status === "delivered" ? "delivered" : "pending";
  db.prepare(`UPDATE files SET
    blob_sha=?,
    status=?,
    dirty=CASE WHEN ? = 1 THEN 1 ELSE 0 END,
    last_seen_commit=?,
    last_seen_commit_at=?,
    last_seen_at=?,
    reviewed_at=NULL,
    issue_number=NULL,
    issue_url=NULL,
    finding_severity=NULL,
    last_error=NULL,
    updated_at=?
    WHERE repo=? AND path=?`)
    .run(input.blobSha, nextStatus, dirty, input.commitSha, input.commitAt, ts, input.repo, input.path);
  return "updated";
}

async function sync(args: Args): Promise<void> {
  const repoPath = await managedRepoPath(args);
  const remote = asString(args.remote, "origin")!;
  const branch = asString(args.branch, "main")!;
  const ref = asString(args.ref, `refs/remotes/${remote}/${branch}`)!;
  const allowedExts = onlyExts(args);
  const db = openDb(args);
  const repo = await repoName(args, repoPath, remote);
  const stateKey = `lastHead:${repo}:${ref}:${[...allowedExts].sort().join(",") || "*"}`;
  const beforeFetchHead = await git(repoPath, ["rev-parse", "--verify", ref], true);

  await git(repoPath, ["fetch", "--prune", remote, branch]);

  const head = await gitRequired(repoPath, ["rev-parse", "--verify", ref]);
  const storedHead = asString(args.base) ?? getState(db, stateKey);
  const shouldBootstrapCurrent = !storedHead && !asString(args.base);
  let base = storedHead || beforeFetchHead || head;
  if (!await git(repoPath, ["rev-parse", "--verify", base], true)) base = head;

  if (base === head && !shouldBootstrapCurrent) {
    setState(db, stateKey, head);
    console.log(JSON.stringify({ repo, repoPath, ref, mode: "incremental", base, head, changedFiles: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, checkpoint: head }, null, 2));
    return;
  }

  const mode = shouldBootstrapCurrent ? "bootstrap-current" : "incremental";
  const files = shouldBootstrapCurrent ? await currentFiles(repoPath, head) : await changedFiles(repoPath, base, head);
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const file of files) {
    if (!pathAllowed(file.path, allowedExts)) {
      skipped++;
      continue;
    }
    const sha = await blobSha(repoPath, head, file.path);
    if (!sha) {
      skipped++;
      continue;
    }
    const last = await fileLastCommit(repoPath, head, file.path);
    const result = enqueueFile(db, { repo, path: file.path, blobSha: sha, commitSha: last.sha, commitAt: last.at });
    if (result === "inserted") inserted++;
    else if (result === "updated") updated++;
    else unchanged++;
  }

  setState(db, stateKey, head);
  console.log(JSON.stringify({ repo, repoPath, ref, mode, base, head, changedFiles: files.length, inserted, updated, unchanged, skipped, checkpoint: head }, null, 2));
}

async function watch(args: Args): Promise<void> {
  const intervalMs = parseDurationMs(asString(args.interval, "60s"), DEFAULT_INTERVAL_MS);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  console.log(JSON.stringify({ watching: true, intervalMs, repoPath: asString(args["repo-path"]) ? resolve(asString(args["repo-path"])!) : null, cloneDir: resolve(asString(args["clone-dir"], DEFAULT_CLONE_DIR)!), repo: asString(args.repo) ?? null, only: [...onlyExts(args)], db: asString(args.db, DEFAULT_DB) }));
  while (!stopping) {
    try {
      await sync(args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    if (!stopping) await sleep(intervalMs);
  }
  console.log(JSON.stringify({ watching: false }));
}

function compactItem(row: ItemRow): unknown {
  return {
    id: row.id,
    repo: row.repo,
    path: row.path,
    blobSha: row.blob_sha,
    status: row.status,
    dirty: Boolean(row.dirty),
    attempts: row.attempts,
    firstSeenCommit: row.first_seen_commit,
    lastSeenCommit: row.last_seen_commit,
    lastSeenCommitAt: row.last_seen_commit_at,
    leaseUntil: row.lease_until,
    workerId: row.worker_id,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    findingSeverity: row.finding_severity,
  };
}

function next(args: Args): void {
  const db = openDb(args);
  const worker = asString(args.worker, `worker-${process.pid}`)!;
  const leaseMs = parseDurationMs(asString(args.lease, "90m"), DEFAULT_LEASE_MS);
  const now = nowIso();
  const leaseUntil = addMsIso(leaseMs);
  const tx = db.transaction(() => {
    const item = db.prepare(`SELECT * FROM files
      WHERE status='pending' OR (status='delivered' AND lease_until IS NOT NULL AND lease_until < ?)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`).get(now) as ItemRow | undefined;
    if (!item) return undefined;
    const changed = db.prepare(`UPDATE files SET
      status='delivered',
      dirty=0,
      attempts=attempts + 1,
      delivered_at=?,
      lease_until=?,
      worker_id=?,
      updated_at=?
      WHERE id=? AND (status='pending' OR (status='delivered' AND lease_until IS NOT NULL AND lease_until < ?))`)
      .run(now, leaseUntil, worker, now, item.id, now).changes;
    if (!changed) return undefined;
    return db.prepare("SELECT * FROM files WHERE id=?").get(item.id) as ItemRow;
  });
  const item = tx();
  if (!item) {
    console.log("No queued files.");
    return;
  }
  console.log(JSON.stringify({ item: compactItem(item) }, null, 2));
}

function ack(args: Args): void {
  const id = Number(asString(args.id));
  const repo = asString(args.repo);
  const path = asString(args.path);
  if (!Number.isFinite(id) && (!repo || !path)) throw new Error("ack requires --id n or --repo owner/name --path file");
  const db = openDb(args);
  const ts = nowIso();
  const where = Number.isFinite(id) ? "id=?" : "repo=? AND path=?";
  const params = Number.isFinite(id) ? [id] : [repo, path];
  const item = db.prepare(`SELECT id, repo, path, dirty FROM files WHERE ${where} AND status='delivered'`).get(...params) as { id: number; repo: string; path: string; dirty: number } | undefined;
  if (!item) throw new Error("No delivered file found for ack");
  if (item.dirty) {
    db.prepare("UPDATE files SET status='pending', dirty=0, delivered_at=NULL, lease_until=NULL, worker_id=NULL, updated_at=? WHERE id=?").run(ts, item.id);
    console.log(JSON.stringify({ repo: item.repo, path: item.path, status: "pending", dirtyWasSet: true }));
    return;
  }
  const issueNumber = asString(args["issue-number"]);
  const issueUrl = asString(args["issue-url"]);
  const severity = asString(args.severity);
  db.prepare(`UPDATE files SET
    status='reviewed',
    dirty=0,
    delivered_at=NULL,
    lease_until=NULL,
    worker_id=NULL,
    reviewed_at=?,
    issue_number=COALESCE(?, issue_number),
    issue_url=COALESCE(?, issue_url),
    finding_severity=COALESCE(?, finding_severity),
    updated_at=?
    WHERE id=?`).run(ts, issueNumber ? Number(issueNumber) : null, issueUrl ?? null, severity ?? null, ts, item.id);
  console.log(JSON.stringify({ repo: item.repo, path: item.path, status: "reviewed" }));
}

function fail(args: Args): void {
  const id = Number(asString(args.id));
  const repo = asString(args.repo);
  const path = asString(args.path);
  if (!Number.isFinite(id) && (!repo || !path)) throw new Error("fail requires --id n or --repo owner/name --path file");
  const maxAttempts = Number(asString(args["max-attempts"], String(DEFAULT_MAX_ATTEMPTS)));
  const reason = asString(args.reason, "")!;
  const db = openDb(args);
  const ts = nowIso();
  const where = Number.isFinite(id) ? "id=?" : "repo=? AND path=?";
  const params = Number.isFinite(id) ? [id] : [repo, path];
  const item = db.prepare(`SELECT id, repo, path, attempts, dirty FROM files WHERE ${where} AND status='delivered'`).get(...params) as { id: number; repo: string; path: string; attempts: number; dirty: number } | undefined;
  if (!item) throw new Error("No delivered file found for fail");
  const dirtyWasSet = item.dirty === 1;
  const status = dirtyWasSet || item.attempts < maxAttempts ? "pending" : "failed";
  db.prepare("UPDATE files SET status=?, dirty=0, delivered_at=NULL, lease_until=NULL, worker_id=NULL, last_error=?, updated_at=? WHERE id=?").run(status, reason, ts, item.id);
  console.log(JSON.stringify({ repo: item.repo, path: item.path, status, attempts: item.attempts, dirtyWasSet }));
}

function stats(args: Args): void {
  const db = openDb(args);
  const rows = db.prepare("SELECT status, COUNT(*) AS count FROM files GROUP BY status ORDER BY status").all();
  console.log(JSON.stringify(rows, null, 2));
}

function usage(): void {
  console.log(`Usage: ghq-commits <command> [options]\n\nCommands:\n  sync --repo owner/name [--clone-dir ./.ghq-commits/repos] [--clone-url url] [--repo-path /path/to/repo] [--remote origin] [--branch main] [--ref refs/remotes/origin/main] [--only .ts,.tsx] [--base sha] [--db path]\n  watch --repo owner/name [--clone-dir ./.ghq-commits/repos] [--repo-path /path/to/repo] [--interval 60s] [--only .ts,.tsx] [--db path]\n  next [--db path] [--worker id] [--lease 90m]\n  ack (--id n | --repo owner/name --path file) [--issue-number n] [--issue-url url] [--severity p0]\n  fail (--id n | --repo owner/name --path file) [--reason text] [--max-attempts 5]\n  stats [--db path]`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === "sync") await sync(args);
    else if (command === "watch") await watch(args);
    else if (command === "next") next(args);
    else if (command === "ack") ack(args);
    else if (command === "fail") fail(args);
    else if (command === "stats") stats(args);
    else {
      usage();
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
