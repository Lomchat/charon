<!--
Thanks for opening a PR.

Before submitting:
- Run the CI gates locally: `npm run typecheck`, `npm test`,
  `npm run test:py`, `npm run build` (build covers protocol sync + Next).
- If you changed any of: JSON-RPC protocol, DB schema, API shape, layout,
  build config, environment variables, deployment topology, agent lifecycle,
  or major UI components — describe the behaviour change in the Summary
  below and add a CHANGELOG entry.
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

- [ ] `npm run typecheck` and `npm run build` pass locally.
- [ ] `npm test` (Vitest) and `npm run test:py` (agent unittest) pass, and I
      added tests covering the change where it's unit-testable.
- [ ] If I touched the JSON-RPC protocol, I bumped
      `agent/charon_agent/__init__.py:__version__`.
- [ ] If I changed anything under `agent/`, I ran `bash agent/build.sh` and
      committed the rebuilt `agent/dist/charon-agent.pyz`
      (`git diff --exit-code agent/dist/charon-agent.pyz` is clean — CI
      fails otherwise).
- [ ] If I added a migration, I committed both the `.sql` and the
      `drizzle/meta/` snapshot.
- [ ] I added a `CHANGELOG.md` entry under `## [Unreleased]`.
- [ ] I updated `README.md` and/or the relevant ADR for any user-visible or
      architectural change; examples and version references still match code.

## Related issues

<!-- "Closes #123", "Related to #456" -->
