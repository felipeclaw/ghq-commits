#!/usr/bin/env node
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_DB = "./ghq-commits.db";
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 70 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const CLONE_ROOT = "./.ghq-commits/repos";
const BRANCH = "main";
const REMOTE = "origin";
const REF = `refs/remotes/${REMOTE}/${BRANCH}`;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);

type Args = { _: string[]; [key: string]: string | boolean | string[] };
type QueueRow = {
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
  delivered_at: string | null;
  lease_until: string | null;
  worker_id: string | null;
  issue_number: number | null;
  issue_url: string | null;
  finding_severity: string | null;
};

type FileInput = {
  repo: string;
  path: string;
  blobSha: string;
  commitSha: string;
  commitAt: string;
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
    args[key] = value;
  }
  return args;
}

function str(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "string") return value;
  if (value == null || typeof value === "boolean") return fallback;
  return String(value);
}

function required(args: Args, key: string): string {
  const value = str(args[key]);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMsIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function durationMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = value.match(/^(\d+)(s|m|h)?$/);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return fallbackMs;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function allowedExts(args: Args): Set<string> {
  return new Set(splitCsv(str(args.only)).map((ext) => ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}

function fileExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx).toLowerCase() : "";
}

function shouldQueue(path: string, exts: Set<string>): boolean {
  if (path.split("/").some((part) => SKIP_DIRS.has(part))) return false;
  return exts.size === 0 || exts.has(fileExt(path));
}

function repoSlug(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, "__");
}

function repoPath(repo: string): string {
  return resolve(CLONE_ROOT, repoSlug(repo));
}

async function git(cwd: string | undefined, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 100 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

async function cloneIfNeeded(repo: string): Promise<string> {
  const path = repoPath(repo);
  if (existsSync(resolve(path, ".git"))) return path;
  await mkdir(CLONE_ROOT, { recursive: true });
  await git(undefined, ["clone", `git@github.com:${repo}.git`, path]);
  return path;
}

async function fetchHead(path: string): Promise<{ before: string; head: string }> {
  const before = await git(path, ["rev-parse", "--verify", REF], true);
  await git(path, ["fetch", "--prune", REMOTE, BRANCH]);
  const head = await git(path, ["rev-parse", "--verify", REF]);
  return { before, head };
}

function parseNameStatus(output: string): string[] {
  const parts = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) i++;
    const path = parts[i++];
    if (path) paths.push(path);
  }
  return paths;
}

async function changedPaths(path: string, base: string, head: string): Promise<string[]> {
  const out = await git(path, ["diff", "--name-status", "-z", "--diff-filter=ACMR", "-M", `${base}..${head}`]);
  return parseNameStatus(out);
}

async function currentPaths(path: string, head: string): Promise<string[]> {
  const out = await git(path, ["ls-tree", "-r", "-z", "--name-only", head]);
  return out.split("\0").filter(Boolean);
}

async function blobSha(path: string, head: string, file: string): Promise<string | null> {
  return await git(path, ["rev-parse", `${head}:${file}`], true) || null;
}

async function lastCommit(path: string, head: string, file: string): Promise<{ sha: string; at: string }> {
  const out = await git(path, ["log", "-1", "--format=%H%x00%cI", head, "--", file]);
  const [sha, at] = out.split("\0");
  return { sha, at: at || nowIso() };
}

function db(args: Args): Database.Database {
  const database = new Database(resolve(str(args.db, DEFAULT_DB)!));
  database.pragma("journal_mode = WAL");
  database.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_files_next ON files(status, created_at, id);
  `);
  return database;
}

function getState(database: Database.Database, key: string): string | undefined {
  return (database.prepare("SELECT value FROM state WHERE key=?").get(key) as { value: string } | undefined)?.value;
}

function setState(database: Database.Database, key: string, value: string): void {
  database.prepare("INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, value, nowIso());
}

function upsertFile(database: Database.Database, input: FileInput): "inserted" | "updated" | "unchanged" {
  const ts = nowIso();
  const existing = database.prepare("SELECT blob_sha, status FROM files WHERE repo=? AND path=?").get(input.repo, input.path) as { blob_sha: string; status: string } | undefined;
  if (!existing) {
    database.prepare(`INSERT INTO files(repo,path,blob_sha,status,dirty,attempts,first_seen_commit,last_seen_commit,last_seen_commit_at,created_at,updated_at)
      VALUES(?,?,?,'pending',0,0,?,?,?,?,?)`)
      .run(input.repo, input.path, input.blobSha, input.commitSha, input.commitSha, input.commitAt, ts, ts);
    return "inserted";
  }
  if (existing.blob_sha === input.blobSha) {
    database.prepare("UPDATE files SET last_seen_commit=?, last_seen_commit_at=?, updated_at=? WHERE repo=? AND path=?")
      .run(input.commitSha, input.commitAt, ts, input.repo, input.path);
    return "unchanged";
  }
  const delivered = existing.status === "delivered";
  database.prepare(`UPDATE files SET
    blob_sha=?, status=?, dirty=?, last_seen_commit=?, last_seen_commit_at=?, reviewed_at=NULL,
    issue_number=NULL, issue_url=NULL, finding_severity=NULL, last_error=NULL, updated_at=?
    WHERE repo=? AND path=?`)
    .run(input.blobSha, delivered ? "delivered" : "pending", delivered ? 1 : 0, input.commitSha, input.commitAt, ts, input.repo, input.path);
  return "updated";
}

async function sync(args: Args): Promise<void> {
  const repo = required(args, "repo");
  const exts = allowedExts(args);
  const database = db(args);
  const path = await cloneIfNeeded(repo);
  const { before, head } = await fetchHead(path);
  const stateKey = `head:${repo}:${[...exts].sort().join(",") || "*"}`;
  const checkpoint = getState(database, stateKey);
  const bootstrap = !checkpoint;
  const base = checkpoint || before || head;
  const candidates = bootstrap ? await currentPaths(path, head) : await changedPaths(path, base, head);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const file of candidates) {
    if (!shouldQueue(file, exts)) {
      skipped++;
      continue;
    }
    const sha = await blobSha(path, head, file);
    if (!sha) {
      skipped++;
      continue;
    }
    const commit = await lastCommit(path, head, file);
    const result = upsertFile(database, { repo, path: file, blobSha: sha, commitSha: commit.sha, commitAt: commit.at });
    if (result === "inserted") inserted++;
    else if (result === "updated") updated++;
    else unchanged++;
  }
  setState(database, stateKey, head);
  console.log(JSON.stringify({ repo, mode: bootstrap ? "bootstrap-current" : "incremental", base, head, files: candidates.length, inserted, updated, unchanged, skipped }, null, 2));
}

async function watch(args: Args): Promise<void> {
  const interval = durationMs(str(args.interval, "60s"), DEFAULT_INTERVAL_MS);
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  console.log(JSON.stringify({ watching: true, repo: required(args, "repo"), intervalMs: interval, db: str(args.db, DEFAULT_DB), cloneRoot: resolve(CLONE_ROOT) }));
  while (!stopped) {
    try {
      await sync(args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function compact(row: QueueRow): unknown {
  return {
    id: row.id,
    repo: row.repo,
    path: row.path,
    blobSha: row.blob_sha,
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
  const database = db(args);
  const worker = str(args.worker, `worker-${process.pid}`)!;
  const now = nowIso();
  const leaseUntil = addMsIso(durationMs(str(args.lease, "70m"), DEFAULT_LEASE_MS));
  const row = database.transaction(() => {
    const item = database.prepare(`SELECT * FROM files
      WHERE status='pending' OR (status='delivered' AND lease_until IS NOT NULL AND lease_until < ?)
      ORDER BY created_at ASC, id ASC LIMIT 1`).get(now) as QueueRow | undefined;
    if (!item) return undefined;
    database.prepare("UPDATE files SET status='delivered', dirty=0, attempts=attempts+1, delivered_at=?, lease_until=?, worker_id=?, updated_at=? WHERE id=?")
      .run(now, leaseUntil, worker, now, item.id);
    return database.prepare("SELECT * FROM files WHERE id=?").get(item.id) as QueueRow;
  })();
  if (!row) {
    console.log("No queued files.");
    return;
  }
  console.log(JSON.stringify({ item: compact(row) }, null, 2));
}

function ack(args: Args): void {
  const id = Number(required(args, "id"));
  const database = db(args);
  const row = database.prepare("SELECT id, repo, path, dirty FROM files WHERE id=? AND status='delivered'").get(id) as { id: number; repo: string; path: string; dirty: number } | undefined;
  if (!row) throw new Error("No delivered file found for ack");
  const ts = nowIso();
  if (row.dirty) {
    database.prepare("UPDATE files SET status='pending', dirty=0, delivered_at=NULL, lease_until=NULL, worker_id=NULL, updated_at=? WHERE id=?").run(ts, id);
    console.log(JSON.stringify({ repo: row.repo, path: row.path, status: "pending", dirtyWasSet: true }));
    return;
  }
  const issueNumber = str(args["issue-number"]);
  database.prepare(`UPDATE files SET status='reviewed', delivered_at=NULL, lease_until=NULL, worker_id=NULL,
    reviewed_at=?, issue_number=COALESCE(?, issue_number), issue_url=COALESCE(?, issue_url),
    finding_severity=COALESCE(?, finding_severity), updated_at=? WHERE id=?`)
    .run(ts, issueNumber ? Number(issueNumber) : null, str(args["issue-url"]) ?? null, str(args.severity) ?? null, ts, id);
  console.log(JSON.stringify({ repo: row.repo, path: row.path, status: "reviewed" }));
}

function fail(args: Args): void {
  const id = Number(required(args, "id"));
  const database = db(args);
  const row = database.prepare("SELECT id, repo, path, attempts, dirty FROM files WHERE id=? AND status='delivered'").get(id) as { id: number; repo: string; path: string; attempts: number; dirty: number } | undefined;
  if (!row) throw new Error("No delivered file found for fail");
  const maxAttempts = Number(str(args["max-attempts"], String(DEFAULT_MAX_ATTEMPTS)));
  const status = row.dirty || row.attempts < maxAttempts ? "pending" : "failed";
  database.prepare("UPDATE files SET status=?, dirty=0, delivered_at=NULL, lease_until=NULL, worker_id=NULL, last_error=?, updated_at=? WHERE id=?")
    .run(status, str(args.reason, "")!, nowIso(), id);
  console.log(JSON.stringify({ repo: row.repo, path: row.path, status, attempts: row.attempts, dirtyWasSet: Boolean(row.dirty) }));
}

function stats(args: Args): void {
  const rows = db(args).prepare("SELECT status, COUNT(*) AS count FROM files GROUP BY status ORDER BY status").all();
  console.log(JSON.stringify(rows, null, 2));
}

function usage(): void {
  console.log(`Usage: ghq-commits <command> [options]\n\nCommands:\n  watch --repo owner/name [--only .ts,.tsx] [--db path] [--interval 60s]\n  sync --repo owner/name [--only .ts,.tsx] [--db path]\n  next [--db path] [--worker id] [--lease 70m]\n  ack --id n [--db path] [--issue-number n] [--issue-url url] [--severity p0]\n  fail --id n [--db path] [--reason text]\n  stats [--db path]`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === "watch") await watch(args);
    else if (command === "sync") await sync(args);
    else if (command === "next") next(args);
    else if (command === "ack") ack(args);
    else if (command === "fail") fail(args);
    else if (command === "stats") stats(args);
    else usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
