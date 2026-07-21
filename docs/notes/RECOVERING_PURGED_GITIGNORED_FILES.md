# Recovering Files That Were Deleted And Then Gitignored

## When this applies

A commit deletes tracked files (`git rm`) **and** a `.gitignore` rule is added for
the same paths in the same or a later commit. From that point on:

- `git pull` will happily replay the deletion on any clone that still has the
  files tracked locally (fast-forward just matches your working tree to the
  new commit).
- Because the paths are now gitignored, git will **never** re-add, restore, or
  protect them again — they're permanently outside version control unless
  someone force-adds them.

Example: `69954ad` ("Remove validate-implementation skill and associated
files") deleted `CLAUDE.md` and `.claude/` under root, `server/`, and
`client/`. `3de1f28` ("stricter gitignore rules") then added
`**/CLAUDE.md` / `**/.claude/` to `.gitignore`. Any clone that pulled through
both commits lost its local `CLAUDE.md` / `.claude/` files with no way for git
to bring them back.

## Recovery procedure

Everything below uses `git show <rev>:<path>`, which reads the exact blob out
of git's object database — never hand-copy/retype content from `git show`
output, always redirect it straight to the file so it's byte-for-byte
identical to what was committed.

**1. Confirm the files are gone and now ignored**
```bash
git status --short
git check-ignore -v <path>          # non-empty output = confirmed ignored
```

**2. Find the commit that deleted the path**
```bash
git log --oneline --diff-filter=D -- <path>
```

**3. Inspect that commit to confirm intent and see everything it touched**
```bash
git show --stat <commit>
```

**4. List every matching file as it existed the moment before deletion**
```bash
git ls-tree -r --name-only <commit>~1 | grep -E '<pattern>'
```

**5. Restore each file from git's object store** (not by re-typing):
```bash
restore() {
  mkdir -p "$(dirname "$1")"
  git show "$2:$1" > "$1"
  echo "restored: $1"
}

REV="<deletion-commit>~1"
restore "path/to/file" "$REV"
# repeat per file from step 4
```

**6. Verify**
```bash
git status --short          # should stay clean — restored files are ignored
git check-ignore -v <path>  # confirms future `git pull` can never touch these again
```

## Notes

- If a deletion commit bundles multiple unrelated cleanups (e.g. it also
  removes an intentionally-obsolete skill/eval workspace), don't blindly
  restore everything in `git show --stat` — read the commit message and
  filter out what was deliberately removed.
- Restored files are local-only from this point on. Git provides no backup
  for them anymore (they're gitignored), so if losing them again would hurt,
  keep a copy outside this repo (personal dotfiles repo, cloud drive, etc.).
- If the real intent is to reverse the gitignore decision (i.e. get these
  files tracked and shared with the team again), that's a different action:
  remove the `.gitignore` entries, then `git add` the restored files and
  commit — worth confirming with whoever authored the original deletion
  first.
