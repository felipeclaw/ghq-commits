# ghq-commits

`ghq-commits` is a small GitHub Queue tool for tracking recently changed files from a managed local git clone and feeding file-level review workers.

“ghq” means “GitHub queue”. This package enqueues the latest version of each changed file, deduped by `repo + path`, so workers review only the current blob instead of stale intermediate commits.

## Command summary

```text
ghq-commits sync --repo owner/name [--clone-dir ./.ghq-commits/repos] [--clone-url url] [--repo-path /path/to/repo] [--remote origin] [--branch main] [--ref refs/remotes/origin/main] [--only .js,.jsx,.ts,.tsx] [--base sha] [--db path]
ghq-commits watch --repo owner/name [--clone-dir ./.ghq-commits/repos] [--repo-path /path/to/repo] [--interval 60s] [--only .js,.jsx,.ts,.tsx] [--db path]
ghq-commits next [--db path] [--worker id] [--lease 90m]
ghq-commits ack (--id n | --repo owner/name --path file) [--issue-number n] [--issue-url url] [--severity p0]
ghq-commits fail (--id n | --repo owner/name --path file) [--reason text] [--max-attempts 5]
ghq-commits stats [--db path]
```

## Processing contract

`ghq-commits` is only the file queue. The consumer is responsible for reviewing the leased file and completing it.

1. Run `sync` periodically or run one long-lived watcher:
   ```bash
   ghq-commits watch --repo owner/repo --only .js,.jsx,.ts,.tsx --db /var/lib/ghq-commits/queue.db --interval 60s
   ```
2. Each review worker leases one file:
   ```bash
   ghq-commits next --db /var/lib/ghq-commits/queue.db --worker reviewer-1 --lease 90m
   ```
3. If `next` prints `No queued files.`, there is no work.
4. If review succeeds, the worker **must** call `ack`:
   ```bash
   ghq-commits ack --db /var/lib/ghq-commits/queue.db --id 123
   ```
5. If the review produced an issue, attach it while acking:
   ```bash
   ghq-commits ack --db /var/lib/ghq-commits/queue.db --id 123 --issue-number 456 --issue-url https://github.com/owner/repo/issues/456 --severity p0
   ```
6. If processing fails before useful output is created, call `fail`:
   ```bash
   ghq-commits fail --db /var/lib/ghq-commits/queue.db --id 123 --reason "review failed"
   ```

A leased file remains `delivered` until `ack`, `fail`, or lease expiry.

## How it works

- `sync` uses local git only; no REST API calls are part of this flow.
- If `--repo-path` is omitted, `sync`/`watch` clones `--repo owner/name` into `./.ghq-commits/repos/owner__name`, a gitignored managed clone directory.
- Override the managed clone location with `--clone-dir`, or the clone remote with `--clone-url`.
- Each sync captures the current local `refs/remotes/origin/main`, runs `git fetch --prune origin main`, then compares the previous checkpoint to the new head.
- Changed files come from:
  ```bash
  git diff --name-status -z --diff-filter=ACMR -M <base>..refs/remotes/origin/main
  ```
- Current file blob hashes come from:
  ```bash
  git rev-parse refs/remotes/origin/main:path/to/file
  ```
- Per-file latest commit metadata comes from:
  ```bash
  git log -1 --format=%H%x00%cI refs/remotes/origin/main -- path/to/file
  ```
- `--only` filters changed files by extension before queue insertion.
- Generated/heavy paths like `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, and `.cache` are skipped.
- Queue rows are keyed by `(repo, path)`.
- If a file has multiple newer commits, the row is upserted to the latest `blob_sha` and `last_seen_commit`.
- If a reviewed file changes blob, it returns to `pending`.
- If a delivered file changes blob while leased, it stays delivered with `dirty = true`; `ack` returns it to `pending` so the latest blob gets reviewed.
- `next` atomically leases one pending file ordered by `created_at ASC, id ASC`.
- Expired leases can be picked up again by `next`.

## First run behavior

If no checkpoint exists, `sync` bootstraps the queue with every current file at the fetched head that passes `--only` and skip filters. It then saves the checkpoint to the fetched head, so future runs become incremental.

To backfill a specific range intentionally, pass `--base <sha>`.

## Payloads

`next` returns compact JSON:

```json
{
  "item": {
    "id": 123,
    "repo": "owner/repo",
    "path": "src/example.ts",
    "blobSha": "abc123",
    "status": "delivered",
    "dirty": false,
    "attempts": 1,
    "firstSeenCommit": "1111111",
    "lastSeenCommit": "2222222",
    "lastSeenCommitAt": "2026-04-29T00:00:00Z",
    "leaseUntil": "2026-04-29T01:30:00Z",
    "workerId": "reviewer-1",
    "issueNumber": null,
    "issueUrl": null,
    "findingSeverity": null
  }
}
```

## Install

```bash
npm install
npm run build
npm link   # optional, exposes ghq-commits locally
```

Requirements:

- Node 20+
- `git`
- SSH/HTTPS access to clone the target repo, unless `--repo-path` points at an existing checkout

## Development

```bash
npm install
npm run check
npm run build
```

The executable is `dist/cli.js` and the package bin is named `ghq-commits`.
