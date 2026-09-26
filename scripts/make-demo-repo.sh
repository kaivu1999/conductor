#!/usr/bin/env bash
# Creates a small, dependency-free JS repo for demoing conductor.
#   bash scripts/make-demo-repo.sh [target-dir] [--force]
# Default target: <conductor-root>/.demo/sample-app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-$ROOT/.demo/sample-app}"

if [ -e "$TARGET" ]; then
  if [ "$FORCE" -ne 1 ]; then
    echo "error: $TARGET already exists (use --force to replace it)" >&2
    exit 1
  fi
  # --force deletes a directory; only do it for something that is clearly a previous demo repo.
  if [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] && ! grep -q '"name": "textkit"' "$TARGET/package.json" 2>/dev/null; then
    echo "error: $TARGET is not a textkit demo repo; refusing to delete it" >&2
    exit 1
  fi
  rm -rf "$TARGET"
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
cd "$TARGET"

gitc() {
  git -c user.name="Demo User" -c user.email="demo@localhost" -c commit.gpgsign=false "$@"
}

git init -q -b main

# ── commit 1: project skeleton + slugify ─────────────────────────────────────
cat > package.json <<'EOF'
{
  "name": "textkit",
  "version": "0.1.0",
  "description": "Tiny text utilities",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "test": "node --test"
  },
  "license": "MIT"
}
EOF

cat > .gitignore <<'EOF'
node_modules/
.DS_Store
EOF

mkdir -p src test

cat > src/slugify.js <<'EOF'
/**
 * Turn arbitrary text into a URL-friendly slug.
 *   slugify('Hello, World!') === 'hello-world'
 */
export function slugify(input, { separator = '-' } = {}) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${escape(separator)}+|${escape(separator)}+$`, 'g'), '');
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
EOF

cat > test/slugify.test.js <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('lowercases and joins words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('drops punctuation and collapses runs', () => {
  assert.equal(slugify('  Hello,   World!!  '), 'hello-world');
});

test('supports a custom separator', () => {
  assert.equal(slugify('a b c', { separator: '_' }), 'a_b_c');
});

test('empty input gives empty slug', () => {
  assert.equal(slugify(''), '');
});
EOF

cat > src/index.js <<'EOF'
export { slugify } from './slugify.js';
EOF

cat > README.md <<'EOF'
# textkit

Tiny, dependency-free text utilities. Run the tests with `npm test` (Node 20+).
EOF

git add -A
gitc commit -q -m "Initial textkit with slugify"

# ── commit 2: wordcount + truncate + TODO list ───────────────────────────────
cat > src/wordcount.js <<'EOF'
/** Count words (runs of non-whitespace) in a string. */
export function wordcount(input) {
  const trimmed = String(input).trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/** Map of lowercase word -> occurrences. */
export function wordFrequencies(input) {
  const freq = {};
  for (const word of String(input).toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    freq[word] = (freq[word] ?? 0) + 1;
  }
  return freq;
}
EOF

cat > test/wordcount.test.js <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordcount, wordFrequencies } from '../src/wordcount.js';

test('counts words separated by any whitespace', () => {
  assert.equal(wordcount('one two\tthree\nfour'), 4);
});

test('empty and whitespace-only input count as zero', () => {
  assert.equal(wordcount(''), 0);
  assert.equal(wordcount('   \n '), 0);
});

test('wordFrequencies is case-insensitive', () => {
  assert.deepEqual(wordFrequencies('The cat and the hat'), { the: 2, cat: 1, and: 1, hat: 1 });
});
EOF

cat > src/truncate.js <<'EOF'
/**
 * Shorten text to at most `max` characters, appending `ellipsis` when cut.
 *   truncate('Hello world', 8) === 'Hello w…'
 */
export function truncate(input, max, { ellipsis = '…' } = {}) {
  const text = String(input);
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}
EOF

cat > test/truncate.test.js <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.js';

test('leaves short strings alone', () => {
  assert.equal(truncate('short', 10), 'short');
});

test('cuts long strings and adds an ellipsis within the limit', () => {
  const out = truncate('Hello world', 8);
  assert.equal(out, 'Hello w…');
  assert.ok(out.length <= 8);
});

test('supports a custom ellipsis', () => {
  assert.equal(truncate('abcdefghij', 6, { ellipsis: '...' }), 'abc...');
});
EOF

cat > src/index.js <<'EOF'
export { slugify } from './slugify.js';
export { wordcount, wordFrequencies } from './wordcount.js';
export { truncate } from './truncate.js';
EOF

cat > README.md <<'EOF'
# textkit

Tiny, dependency-free text utilities. Run the tests with `npm test` (Node 20+).

```js
import { slugify, wordcount, truncate } from './src/index.js';

slugify('Hello, World!');      // 'hello-world'
wordcount('one two three');    // 3
truncate('Hello world', 8);    // 'Hello w…'
```

## Ideas / TODO

Each of these is a good small task for an agent (add tests for each!):

1. **Add a `titleCase` function** in `src/titlecase.js` — `titleCase('the quick fox')` → `'The Quick Fox'`; keep small words like "of", "and", "the" lowercase unless first. Export it from `src/index.js`.
2. **`slugify` should handle unicode accents** — `slugify('Crème Brûlée')` should give `'creme-brulee'`, not `'cr-me-br-l-e'` (hint: `String.prototype.normalize('NFD')`).
3. **`slugify` should support a `maxLength` option** — `slugify(text, { maxLength: 20 })` trims the slug without leaving a trailing separator.
4. **`truncate` should not cut words in half** — prefer breaking at the last space before the limit, falling back to a hard cut for a single long word.
5. **Add `readingTime(text, { wpm = 200 })`** to `src/wordcount.js` — returns whole minutes, at least 1 for non-empty text.
EOF

git add -A
gitc commit -q -m "Add wordcount and truncate, README with TODO list"

# Sanity check: baseline must be green.
if command -v node >/dev/null 2>&1; then
  if ! node --test >/dev/null 2>&1; then
    echo "error: baseline tests failed in $TARGET" >&2
    exit 1
  fi
fi

echo "Demo repo ready at $TARGET"
echo "  branch: main ($(git rev-list --count HEAD) commits), tests: npm test"
echo "  TODO items 2 and 3 both edit src/slugify.js — run them in parallel to demo a merge conflict."
