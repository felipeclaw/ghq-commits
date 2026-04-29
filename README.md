# ghq-commits

`ghq-commits` is a small GitHub Queue tool for tracking recently changed files from repository commits and feeding file-level review workers.

“ghq” means “GitHub queue”. This package is intended to enqueue the latest version of each changed file, deduped by `repo + path`, so workers review only the current blob instead of stale intermediate commits.

## Planned shape

- Poll recent commits for selected repositories.
- Filter changed files by extension, e.g. `--only .js,.jsx,.ts,.tsx`.
- Store a SQLite queue keyed by `(repo, path)`.
- Upsert newer commits for the same file instead of accumulating stale entries.
- Let review workers lease one file at a time and create issues for confirmed high-severity findings.

## Status

Initial repository scaffold. Implementation coming next.
