---
title: Bump the plugin version on every release — claude plugin update is version-gated, not content-gated
date: 2026-06-24
category: developer-experience
module: packaging
problem_type: developer_experience
component: tooling
applies_when:
  - "Shipping changes to a Claude Code marketplace plugin that users install"
  - "A feature or fix has merged but you want installed users to actually receive it"
  - "`claude plugin update` reports 'already at the latest version' despite new commits"
tags: [versioning, semver, plugin, marketplace, release, claude-plugin-update]
---

# Bump the plugin version on every release — `claude plugin update` is version-gated, not content-gated

## Context

This plugin shipped its entire `orch-next` + `orch-fanout` family (executor, circuit breaker,
recovery, model-aware fan-out) plus docs across nine merged PRs — while the `version` field in
`.claude-plugin/plugin.json` stayed frozen at `0.1.0`, exactly as the bootstrap commit set it.
A user then ran `claude plugin update` and got: *"already at the latest version (0.1.0)."* All
that merged work would never have reached an installed user.

## Guidance

`claude plugin update` compares the **declared version string** in the plugin manifest against
the installed version — not the git content. If the manifest version hasn't changed, the
installer concludes there's nothing new, regardless of how many commits landed on the branch
the marketplace points at. So:

- **Bump `version` in `.claude-plugin/plugin.json` on every release** (and the marketplace's
  `metadata.version` for consistency). Treat it as a required, visible part of shipping — the
  same discipline as keeping a README test count or changelog current, not an afterthought.
- **Follow semver.** Pre-1.0 (`0.y.z`) treats the surface as unstable: minor bumps (`0.2.0`,
  `0.3.0`) carry features and even breaking changes freely. Reserve `1.0.0` for when you mean
  "stable, I'm committing to this shape." Patch (`0.0.z`) for fixes only.
- Because the check is version-gated, **a release with no version bump is invisible to users**
  even though `main` is correct — the worst kind of bug, because nothing errors.

## Why This Matters

The failure is silent and asymmetric: `main` is right, the code is merged, CI is green, and the
installer cheerfully reports "latest" — so you believe users have the new work when they have
none of it. There's no error to chase; you only notice if you happen to run `update` and read
the version number. Bumping the version is the one action that flips merged work into a
delivered release.

## When to Apply

- Every release of an installable plugin. If a PR adds a feature or fixes a bug users should
  get, the same change (or the release that batches it) bumps the version.
- When `claude plugin update` says "already at latest" but you know work has merged — the
  version wasn't bumped; that's the fix.

## Examples

- **Before:** `version: "0.1.0"` unchanged across 9 feature PRs → `claude plugin update` →
  "already at the latest version (0.1.0)." Users stuck on the bootstrap-only plugin.
- **After:** bump to `0.2.0` (pre-1.0 minor — `orch-decompose`-only → the full family) in both
  `.claude-plugin/plugin.json` and the marketplace `metadata.version`; push; `claude plugin
  update` now fetches the new release.

## Related

- `.claude-plugin/plugin.json` (the `version` the installer reads) and
  `.claude-plugin/marketplace.json` (`metadata.version`).
