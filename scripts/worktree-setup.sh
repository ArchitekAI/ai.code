#!/usr/bin/env bash
set -euo pipefail

src="${T3CODE_PROJECT_ROOT:?}"
dst="${T3CODE_WORKTREE_PATH:-.}"

echo "Copying .env files from $src to $dst..."

while IFS= read -r -d '' f; do
  rel="${f#"$src"/}"
  mkdir -p "$dst/$(dirname "$rel")"
  cp "$f" "$dst/$rel"
  echo "  copied $rel"
done < <(find "$src" -name '.env*' \
  -not -name '.env.example' \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/.turbo/*' \
  -not -path '*/dist/*' \
  -print0)

echo "Installing dependencies..."
bun install
echo "Worktree setup complete."
