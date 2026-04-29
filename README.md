# ghq-commits

Tiny SQLite queue for reviewing files changed in a GitHub repo.

It clones the repo into a gitignored managed folder, bootstraps all current matching files on first run, then only enqueues files changed on `main` after that. Queue identity is `repo + path`, so if a file changes multiple times before review, only the latest blob is kept.

## Commands

```bash
# Keep syncing changed files every minute.
ghq-commits watch --repo owner/repo --only .js,.jsx,.ts,.tsx --db queue.db --interval 60s

# Run one sync now.
ghq-commits sync --repo owner/repo --only .js,.jsx,.ts,.tsx --db queue.db

# Lease one file for a reviewer.
ghq-commits next --db queue.db --worker reviewer-1 --lease 70m

# Mark the leased file reviewed.
ghq-commits ack --db queue.db --id 123

# Mark reviewed and attach a created issue.
ghq-commits ack --db queue.db --id 123 --issue-number 456 --issue-url https://github.com/owner/repo/issues/456 --severity p0

# Retry/fail a leased file.
ghq-commits fail --db queue.db --id 123 --reason "review failed"

# Counts by status.
ghq-commits stats --db queue.db
```

## Behavior

- Managed clone path: `./.ghq-commits/repos/owner__repo`.
- Clone URL: `git@github.com:owner/repo.git`.
- Branch: `origin/main`.
- First sync without a checkpoint queues every current file matching `--only`.
- Later syncs run `git fetch --prune origin main` and compare checkpoint → latest `origin/main`.
- Skips heavy/generated folders: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache`.
- Upserts by `(repo, path)` so stale intermediate commits do not pile up.
- If a leased file changes before `ack`, it is marked dirty and `ack` puts it back to pending.

## Install/dev

```bash
npm install
npm run check
npm run build
```

Requires Node 20+ and git access to the target repo.
