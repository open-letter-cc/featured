# Open Letter Computer Club — featured apps

Every folder in `apps/` is a git submodule pointing at a featured app at the
commit we last updated to. A nightly Action moves each one to its latest
commit and rebuilds `featured.json`, which the openletter.club homepage reads.

## Feature an app

```sh
git submodule add --depth 1 https://github.com/owner/repo apps/repo
git commit -m "feature: owner/repo"
```

## List an Open Letter licensed project

Add the repo URL to `licensed.txt` in a PR. Licensed projects are shown by
title and short description at the bottom of the featured list.

## openletter.json (in the app's own repo, optional for featured apps)

```json
{
  "title": "Short name",
  "description": "One or two sentences, up to 280 characters.",
  "license": "open-letter",
  "sponsor": "https://github.com/sponsors/owner",
  "homepage": "https://example.org"
}
```

A featured app without this file falls back to its README's first heading and
paragraph, then to its GitHub description. A licensed project must have the
file, with `"license": "open-letter"`.

## featured.json

Generated; don't edit by hand. Run `node scripts/build.mjs` to build it locally
(`OFFLINE=1` skips the GitHub API).
