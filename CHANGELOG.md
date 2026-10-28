# Changelog

All notable changes to Plex Lite. The format follows [Keep a Changelog](https://keepachangelog.com),
and versions follow [semver](https://semver.org). The version lives in `appinfo.json` and in
`PL.VERSION` (`js/core.js`), and `tools/check.mjs` fails if they differ. Tag releases `vX.Y.Z`.

While the version is `0.x`, a minor bump (0.2.0) may change behaviour or the plugin API. Patch
releases are fixes only.

## [Unreleased]

### Added

- **New first run** (docs/FIRSTRUN.md), on the TV and the web: a poster-wall welcome screen (free-licence
  posters, credited), Plex's sign-in page in a popup with a clear "blocked" path, a plex.tv/link code
  with a QR code that fills the code in, Who's watching? for Plex Home accounts with PIN entry (PIN
  profiles now work in Settings → Profile too), an explainer before the browser's local-network prompt,
  a connecting sheet with a row per route, and error sheets for no server, an unreachable server (what
  was tried per route), no libraries and plex.tv being down. On the web it fills the window with its own
  layouts for desktops, phones (portrait and landscape) and ultrawide screens. Server discovery reports
  error codes (`err.code`, `err.routes`) instead of message strings. The web build now uses Inter
  (self-hosted) throughout.
- **Input modes on the web** (docs/WEB.md, "Input modes"): the web build tells remote, mouse and
  keyboard, and touch apart. It starts from the browser's pointer media queries (TV browsers and
  anything unclear start as remote), then follows the last input used: a touch, a real mouse move,
  or arrow keys and Enter (which bring up the focus plate and keyboard hints without changing the
  layout). Settings → Controls pins Automatic / Remote / Mouse & keyboard / Touch per browser. Key
  hints follow the mode (OK or Enter, Back or Esc, none for touch). For the rest of the web layer:
  `PL.input.mode()`, change events and `<html data-input data-nav>`. The TV app is unchanged.
- **Overseerr on the web** (docs/OVERSEERR.md, "On the web"): in the web build the Overseerr plugin
  calls your Overseerr straight from the browser (`plugins/overseerr/seerr-web.js`, the same methods
  and messages as the TV's service, per-profile sign-in over the browser's one cookie, changes checked
  against `/auth/me` first). It needs Plex Lite served from the same site as Overseerr and CORS with
  credentials on Overseerr's proxy (Nginx / Nginx Proxy Manager and Cloudflare Worker examples); when
  either is missing, or Overseerr's CSRF protection is on, the plugin explains which in a sheet. Plugins
  can declare `web: true` to run on the web without their services. The TV app is unchanged.
- **Plex Lite on the web** (https://plexlite.vercel.app, docs/WEB.md): the same app in a desktop
  browser, built by `tools/build-web.mjs` and deployed on Vercel. Sign in with Plex (Plex's sign-in
  page in a popup, or a plex.tv/link code), https `*.plex.direct` connections only (local, Remote
  Access, relay) with Chrome's local-network permission handled, browser playback (direct play of what
  the browser decodes, H.264/AAC HLS from the Plex transcoder otherwise, through hls.js or Safari's
  own HLS) including Live TV, the 1920x1080 layout scaled to any window, keyboard and mouse
  equivalents for the remote (right-click or a long press is hold OK), the browser's Back button as
  Back, and sessions stopped when the tab closes. Overseerr is TV-only for now; web plugins run in a
  sandboxed frame page. Strict Content-Security-Policy and security headers in `vercel.json`.
  The TV app is unchanged.

- A–Z rail in the Library view (title sort): the current letter follows the focus; Right from the
  last column enters it, OK jumps to the letter's first title, and the number keys jump like a phone
  keypad (2 = A, again = B ...). Uses Plex's `firstCharacter` counts with the active filters, so a
  jump loads only the titles around the target. Z–A sorts flip it; other sorts hide it.
- The demo server answers `firstCharacter`.
- Search finds Live TV: a Channels row (by name, ignoring IPTV group prefixes like "UK - " and
  quality tags, or by number; logo, number, what's on now and its progress) and an On TV row
  (programmes on now or later in the loaded guide, matched by title). OK watches a channel or a
  programme on now, and opens the guide on a later programme's slot; hold OK for Watch, Show in
  guide and Favourites. Matched on the TV with the library search's scorer, from an index rebuilt
  when the guide changes, so typing doesn't wait. Without guide data, channel names still match.
- The demo server's `PLEXLITE_DEMO_CHANNELS=600` pads the lineup with invented IPTV-style channels.
- Search puts Channels and On TV first when the query is about channels (a channel name word or
  number starts with it, and no library title is exactly it); the order never changes under the focus.
- White channel logos get a dark plate in the guide and Search (each logo is sampled once).
- Live TV Browse (docs/LIVETV-browse-design.md): Blue, Left at the start of the guide or OK on the
  first chip open a Browse rail of Favourites, All channels, On now, categories (Entertainment,
  Movies, Sport, News, Documentaries, Kids, Music, Shopping…) and channel families found in the
  channel names (a brand shared by 3+ channels, with sub-families), each with a count. The guide
  behind previews the focused choice; the chips refine it by the other dimension (a category's
  families, a family's categories). Categories come from the guide's own genres (shows looked up 40
  at a time in the background) with a channel-name fallback, remembered per server.
- On now wall: the rail's On now shows shelves of what's on now by category, with programme art,
  the channel's logo and progress; OK watches and CH+/CH− surf that shelf.
- The mini guide and CH+/CH− follow the Browse choice; Blue over the picture opens the rail, and the
  mini guide names the choice and its size. Number entry in the player reaches every channel and
  switches to All channels when needed. The banner and mini guide get the dark plate for white logos.
- The demo server's padded lineup adds invented channel brands, and episodes carry their genres on
  their shows, as on a real Plex DVR.

### Changed

- Live TV's filter row (All, Favourites, Movies, Sports, News) is replaced by the Browse rail and its
  chips; Blue opens Browse on the Live TV tab and in the live player (the frame-time overlay stays on
  Blue elsewhere).
- Live TV rebuilt (docs/LIVETV-v2-design.md). The tab is a two-hour guide grid of every channel in
  the DVR's lineup (channels without guide data too), with the focused programme's details, synopsis
  and artwork above it, filters (All, Favourites, Movies, Sports, News), number keys to jump to a
  channel, Favourites (hold OK or Yellow; the guide opens on Favourites once there are some), and
  Back to return to now. Programmes load in three-hour blocks for all channels, so moving never
  waits on the network.
- The live player has its own controls: a channel banner on every zap (logo, number, programme,
  progress, time left, what's next), a mini guide over the picture (Up/Down), number entry, last
  channel (an icon, or Red), and Favourite. Pausing shows how far behind live you are, with Go live.
  Changing channel releases the old tuner session before tuning the next (one-tuner setups), tries
  again while the server frees the tuner, and a refused tune says so in words. Channel keys, numbers and the mini guide also work while tuning or
  after a failed tune.
- The demo server's Live TV has 24 channels with realistic schedules, the lineup, programme details
  and playable tuning (one channel always fails, two have no guide data).

- Player rebuilt after the Apple TV app (with some Netflix): nothing on screen while watching;
  any key brings up the title, a seek bar split into chapters, the times ("−5:35 · Ends at 21:14"),
  round Subtitles / Audio / Next episode icons and Info / Chapters / Episodes tabs. They hide after
  5 seconds and stay while paused. Left/Right jump back 10 s / forward 30 s straight away (taps add
  up); holding them, or Left/Right while paused, scrubs with a large time and chapter label riding the
  target (or Plex's preview frame, on servers that make preview thumbnails); OK jumps there, Back
  returns. OK pauses.
- Subtitles and audio change from a small menu above their icon while the video keeps playing;
  picture subtitles are marked as burned in by the server. Subtitle size (Small, Medium, Large) is
  under "Size and style".
- Down from the bar opens tabs: Info (synopsis, Start from the beginning, what is playing and
  whether the server converts it), Cast (the people in it, with guest stars first on an
  episode, then the show's cast), Chapters (cards with thumbnails when Plex has them; OK seeks)
  and Episodes (the season; OK plays one).
- Skip Intro / Skip Credits is a large focused button (OK skips) with a line showing the time
  left; it returns, above the icons, whenever the controls are opened during the intro or credits.
  Fast-forward (or a keyboard's next-track key) jumps to the end of an intro or skips the credits,
  and moves forward 30 s elsewhere.
- At the end credits of an episode with a next one, an end card shows what is next with Watch
  Credits and a "Next Episode in 10" countdown (if autoplay is on). Movies and last episodes keep
  Skip Credits.
- Magic Remote: hovering focuses, clicking presses; hover the bar for the time (and preview),
  click it to seek there.
- The demo server advertises preview thumbnails and serves index frames
  (`/library/parts/<id>/indexes/sd/<ms>`).

### Fixed

- Changing live channel tells Plex the old channel's session stopped (it was listed as playing for minutes).
- Focus in the player and the live controls no longer makes labels jump. On the TV's Chrome 53 a
  focused tab, card or button that scaled was drawn one way while it moved and another at rest, so
  its text shifted as the pop started and again as it landed. Labels now stay still and the focus
  travels instead, as on the tab bar: one disc for the round icons, one capsule for the tabs and
  for the end card's buttons, one plate for the subtitle and audio menus, and a still plate the mini
  guide's rows glide under. Only artwork pops, from its centre, and it is kept on its own layer
  while it is scaled. Labels switch ink as the focus arrives.

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
