# Contributing

Thanks for helping. Plex Lite exists to be fast on old TVs, so changes are judged by how they run on
a webOS 4.5 TV (Chrome 53, a 1.1 GHz CPU and a weak GPU), not on a desktop.

## Ground rules

- **Chrome 53 only.** Write ES5 plus the ES2015 that Chrome 53 has (`let`/`const`, arrow
  functions, classes and promises are fine). Don't use `async`/`await`, `Object.entries`/`values`,
  `padStart`, `Array.prototype.flat`, `Promise.finally`, CSS grid, flex `gap`, `position: sticky`,
  `clamp()`/`min()`/`max()` or `backdrop-filter`. Every JS file starts with `'use strict';`.
- **No build step, no dependencies.** The app is plain files loaded by `index.html`. Don't add
  frameworks or npm packages to the app. Small, focused code is the point.
- **Cheap to draw.** Animate only `transform` and `opacity`. Keep the DOM small, and remove what
  is off screen. Ask the Plex server for images at the size they're shown. See
  [docs/DESIGN.md](docs/DESIGN.md) and [docs/MOTION.md](docs/MOTION.md).
- **No personal data or secrets.** No tokens, server addresses, library titles or screenshots of
  your own library in commits. Tool settings go in `tools/local.env`
  (see `tools/local.env.example`).

## Before you open a pull request

```sh
node tools/check.mjs          # Chrome 53 compatibility and version check (needs acorn, see the file)
node test/fuzzy.test.mjs      # search tests
python3 tools/build-ipk.py /tmp/plexlite.ipk   # still packages
```

If you can, try the change on a TV (`tools/deploy.sh`) and say in the PR which TV and webOS
version you used. Mention user-visible changes under `[Unreleased]` in `CHANGELOG.md`.

## Plugins

New integrations should usually be plugins rather than changes to the screens. See
[docs/PLUGINS.md](docs/PLUGINS.md).

## Licence

By contributing you agree that your contribution is licensed under the project's
[MIT licence](LICENSE).
