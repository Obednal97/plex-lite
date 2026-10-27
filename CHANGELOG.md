# Changelog

All notable changes to Plex Lite. The format follows [Keep a Changelog](https://keepachangelog.com),
and versions follow [semver](https://semver.org). The version lives in `appinfo.json` and in
`PL.VERSION` (`js/core.js`), and `tools/check.mjs` fails if they differ. Tag releases `vX.Y.Z`.

While the version is `0.x`, a minor bump (0.2.0) may change behaviour or the plugin API. Patch
releases are fixes only.

## [Unreleased]

## [0.1.0] - unreleased (first public release)

### Added

- Libraries with Recommended, Library (sort, genre, decade, unwatched) and Collections views.
- Title pages: cast and crew, trailers and extras, ratings, versions, seasons and episodes. Person
  pages for cast and crew.
- Player: direct play or transcoding, resume, seeking, audio and subtitle choice, chapters, skip
  intro and credits, autoplay with Up Next.
- Typo-tolerant fuzzy search as you type, plus episodes and people from the server.
- Live TV guide and playback through Plex Live TV & DVR.
- Sign in with a plex.tv/link code, Plex Home profile switching, manual server addresses.
- Pointer (Magic Remote) support, launch deep links (`{ratingKey, action}`) and hold-OK quick
  actions.
- Design refresh: grey ground, full-bleed art, larger cards, a "lit glass" focus edge and
  spring-fitted motion.
- Plugin system (Phase 1: bundled, reviewed plugins) and the Overseerr plugin.
- Release preparation: MIT licence, third-party notices and trademark disclaimer, an original app
  icon (`assets/icon.svg`), a brand-teal accent and progress colour in place of Plex's amber, build-time app id (`--app-id` / `PLEXLITE_APP_ID`), and dev tools
  configured through `tools/local.env` instead of personal defaults.
