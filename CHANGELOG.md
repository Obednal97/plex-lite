# Changelog

All notable changes to Plex Lite. The format follows [Keep a Changelog](https://keepachangelog.com),
and versions follow [semver](https://semver.org). The version lives in `appinfo.json` and in
`PL.VERSION` (`js/core.js`), and `tools/check.mjs` fails if they differ. Tag releases `vX.Y.Z`.

While the version is `0.x`, a minor bump (0.2.0) may change behaviour or the plugin API. Patch
releases are fixes only.

## [Unreleased]

### Added

- A–Z rail in the Library view (title sort): the current letter follows the focus; Right from the
  last column enters it, OK jumps to the letter's first title, and the number keys jump like a phone
  keypad (2 = A, again = B ...). Uses Plex's `firstCharacter` counts with the active filters, so a
  jump loads only the titles around the target. Z–A sorts flip it; other sorts hide it.
- The demo server answers `firstCharacter`.

## [0.1.0] - 2026-10-27 (first public release)

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
- Surprise Me in Movies and TV Shows (and on collections): a random unwatched pick (a show's next
  episode), honouring Library filters and the Plex Home profile, revealed full-screen with an 8-second
  countdown, Spin again and Details; recent picks are remembered across restarts.
- Plugin system: bundled plugins, plus a plugin catalogue (Settings → Plugins → Browse) with
  SHA-256-pinned, sandboxed web plugins, per-permission consent (the Plex token is a "Sensitive"
  permission), up to two plugin tabs, details-page actions and badges, update and remove.
- Overseerr plugin: requests from search, a Downloading screen, shelf and title-page badge, and
  "Report a problem" (an Overseerr issue under the viewer's own account); one Overseerr session per
  Plex Home profile.
- A sign-in revoked mid-session shows one "signed out" screen (or reconnects when only the server's
  token changed) instead of failing screen by screen; error messages no longer show request URLs.
- A demo Plex server (`tools/demo/`) with openly licensed films, used for the README screenshots.
- Release preparation: MIT licence, third-party notices and trademark disclaimer, an original app
  icon (`assets/icon.svg`), a brand-teal accent and progress colour in place of Plex's amber, build-time app id (`--app-id` / `PLEXLITE_APP_ID`), and dev tools
  configured through `tools/local.env` instead of personal defaults.
