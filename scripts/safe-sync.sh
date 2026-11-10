#!/usr/bin/env bash
# Safely bring the local checkout up to date with origin/main.
#
# Replaces `git fetch && git reset --hard origin/main`, which silently throws
# away any uncommitted or unpushed work. This script:
#   1. Refuses to run outside a git repo.
#   2. Checks git status first and reports any local changes.
#   3. If there are local changes, saves them to a timestamped backup branch
#      and stashes them, so nothing is lost.
#   4. Fast-forwards to origin/main. It never force-resets.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Not inside a git repository." >&2
  exit 1
}

echo "== git status =="
git status --short --branch

git fetch origin main --quiet

if [ -n "$(git status --porcelain)" ]; then
  backup="backup/pre-sync-$(date -u +%Y%m%d-%H%M%S)"
  echo "Local changes found. Saving a backup branch: $backup"
  git stash push --include-untracked -m "pre-sync $(date -u +%FT%TZ)"
  git branch "$backup" stash@{0}
  echo "Changes are in stash@{0} and on branch $backup."
fi

if git merge --ff-only origin/main --quiet; then
  echo "Up to date with origin/main at $(git rev-parse --short HEAD)."
else
  echo "Cannot fast-forward. Local commits differ from origin/main." >&2
  echo "Nothing was overwritten. Resolve manually, then re-run." >&2
  exit 1
fi
