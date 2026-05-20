<!--
Thanks for opening a PR.

Before submitting:
- Run `npm run build` locally (it covers tsc + protocol sync + Next build).
- If you changed any of: JSON-RPC protocol, DB schema, API shape, layout,
  build config, environment variables, deployment topology, agent lifecycle,
  or major UI components — update CLAUDE.md in the same commit (checklist
  at the top of that file).
- Keep the PR focused on a single logical change.
-->

## Summary

<!-- 1-3 lines: what does this PR do and why. -->

## Changes

<!-- Bullet list of what changed at a high level. -->

-

## Testing

<!--
How did you verify this works? Manual repro steps, automated tests, both?
For UI changes, a screenshot or short clip helps reviewers.
-->

## Checklist

- [ ] `npm run build` passes locally.
- [ ] If I touched the JSON-RPC protocol, I bumped
      `agent/charon_agent/__init__.py:__version__` and ran
      `bash agent/build.sh`.
- [ ] If I changed something documented in `CLAUDE.md`, I updated it.
- [ ] If I added a migration, I committed both the `.sql` and the
      `drizzle/meta/` snapshot.
- [ ] I added a `CHANGELOG.md` entry under `[Unreleased]`.

## Related issues

<!-- "Closes #123", "Related to #456" -->
