# Home Assistant plugin: Movie mode

`plugins/home-assistant/plugin.js` sends Plex Lite's playback events ([onPlayback](../../docs/PLUGINS.md#onplaybackevent-ctx))
to a [Home Assistant](https://www.home-assistant.io) webhook. An automation in Home Assistant does
the rest: dim the lights when a film starts, bring them back on pause or stop. Plex Lite knows
nothing about lights; Home Assistant knows nothing about Plex.

## Settings

**Settings → Plugins → Home Assistant** (TV and web; on phones it's a sheet):

| Row | |
|---|---|
| Local webhook URL | `http://<Home Assistant>:8123/api/webhook/<id>`. A bare host gets `http://`. Use the IP address if `homeassistant.local` doesn't resolve on the TV |
| Remote webhook URL | optional: `https://<your domain>/api/webhook/<id>`, or a Nabu Casa cloudhook `https://hooks.nabu.casa/<id>`. Must be https |
| Movie mode | On (default) / Off. Off sends nothing (except the lights coming back up if they were down) |
| Dim the lights for | Films only · **Films and shows** (default) · Everything, including Live TV (and trailers) |
| Lights up after a pause | At once · **5 seconds** (default) · 15 seconds |
| Send a test | sends an event `test` |
| Last sent / Last error | e.g. "play · 21:04 · local"; errors during playback are only logged and shown here |

Settings shows only the host of a URL, never the webhook id.

## What it sends, and when

Movie mode turns the playback events into "lights down" and "lights up":

- `play` / `resume` of matching content, when the lights aren't down already → sent at once.
- `pause` / `stop` / `ended` while they are down → sent after the delay. A `play` or `resume` within
  the delay cancels it and nothing at all is sent: a quick pause, or Up Next playing the next
  episode, doesn't flash the lights. A `stop` during a pause's wait replaces it.
- While the app leaves the foreground (or a browser tab closes) a pending event goes at once.
- Buffering events are not sent.

Each POST is a form (`application/x-www-form-urlencoded`), which Home Assistant's webhook trigger
reads as `trigger.data.<field>` (strings):

| Field | |
|---|---|
| `source` | `plexlite` |
| `event` | `play`, `resume`, `pause`, `stop`, `ended` or `test` |
| `kind`, `type` | `movie` / `series` / `live` (empty for trailers); `movie` / `episode` / `live` / `clip` |
| `title`, `show_title`, `season`, `episode`, `year` | as Plex has them |
| `genres` | up to three, comma-separated |
| `content_rating`, `is_kids` | `is_kids` is `true` or `false` (rule in [PLUGINS.md](../../docs/PLUGINS.md#onplaybackevent-ctx)) |
| `channel`, `live_category` | Live TV: the channel; `sports`, `news`, `kids`, `movie`, `series` or empty |
| `at`, `position_ms`, `duration_ms` | milliseconds |
| `payload` | the whole event as JSON (`trigger.data.payload \| from_json`) |

Nothing identifies the Plex server, the account or the profile.

## Transport

- **A webhook, not a long-lived access token.** A token is full access to Home Assistant (every
  device, every service) and would sit in the TV's or the browser's storage. A webhook id can only
  fire the one trigger it belongs to, with the data it is given, and the lights logic stays in Home
  Assistant next to the lights. The REST API also needs an `Authorization` header, so every call would
  be a CORS preflight that Home Assistant answers only for origins listed in `cors_allowed_origins`
  (the TV app's origin is `null`); the webhook endpoint allows CORS from any origin by design.
- **A form, not JSON.** A form POST is a CORS "simple" request: no preflight. That matters for Nabu
  Casa's relay, which forwards the request to Home Assistant but doesn't answer an `OPTIONS` preflight
  as Home Assistant's own server does. A `text/plain` body would avoid the preflight too, but the
  webhook trigger drops it (it parses only JSON and form bodies).
- **`fetch` in `no-cors` mode.** It resolves when a server answered and rejects when nothing did,
  without reading the answer (Nabu Casa's answer carries no CORS headers). Home Assistant answers 200
  to every webhook call, even for an id it doesn't know, so "answered" is all anyone can learn: the
  test says "Home Assistant answered. Check that your automation ran."
- **Routes.** On the TV: the local URL first with a 1.5 s timeout, then the remote one; the route that
  worked is tried first for the next 10 minutes, so a TV away from the local network doesn't wait
  1.5 s on every event. With only one URL it gets 8 s. In a browser (an https page) only the remote
  URL is used: a page on https can't call Home Assistant's plain-http address on the local network.
  With only a local URL set, the settings page says "Add a remote webhook URL" ("Needs a remote URL"
  in Settings).
- A late local answer and the remote one can both arrive. Make the Home Assistant side idempotent
  (the template sensor below is: a repeated `play` doesn't change its state).

## Local only, or remote too

Home Assistant's webhook trigger is **local only** by default (`local_only: true`, "Only accessible
from the local network"): calls from outside the local network, and through Nabu Casa, are ignored
(and still answered 200). That is the safe setting and all the TV app needs at home.

A remote URL only works with local-only **switched off**. The webhook id then becomes a secret: anyone
who has it can fire the trigger from anywhere (here: dim or restore the lights). Use a long random
id, don't reuse it, and keep remote off unless you use Plex Lite in a browser or away from home.

## The Home Assistant side

Recommended: a **trigger-based template sensor** fed by the webhook, so other automations, scenes
and dashboard cards can use a normal entity, and a Movie mode **automation that triggers on the
sensor's state**. (Home Assistant lets several webhook triggers share one id, but the first one
registered decides `local_only`; going through the sensor keeps one place for that, and a repeated
event doesn't re-trigger anything.)

```yaml
input_boolean:
  plex_lite_dimmed:
    name: Plex Lite dimmed the lights

template:
  - triggers:
      - trigger: webhook
        webhook_id: "<a long random id>"
        allowed_methods: [POST]
        local_only: true
    sensor:
      - name: Plex Lite playback
        unique_id: plex_lite_playback
        icon: mdi:television-play
        state: >
          {% set e = trigger.data.event %}
          {% if e in ['play', 'resume'] %}playing
          {% elif e == 'pause' %}paused
          {% elif e in ['stop', 'ended'] %}idle
          {% else %}{{ this.state if this.state in ['playing', 'paused', 'idle'] else 'idle' }}{% endif %}
        attributes:
          event: "{{ trigger.data.event }}"
          kind: "{{ trigger.data.kind | default('') }}"
          type: "{{ trigger.data.type | default('') }}"
          title: "{{ trigger.data.title | default('') }}"
          show: "{{ trigger.data.show_title | default('') }}"
          season: "{{ trigger.data.season | default('') }}"
          episode: "{{ trigger.data.episode | default('') }}"
          genres: "{{ trigger.data.genres | default('') }}"
          content_rating: "{{ trigger.data.content_rating | default('') }}"
          is_kids: "{{ trigger.data.is_kids == 'true' }}"
          channel: "{{ trigger.data.channel | default('') }}"
          live_category: "{{ trigger.data.live_category | default('') }}"
          received: "{{ now().isoformat() }}"

automation:
  - alias: Plex Lite movie mode
    mode: queued
    triggers:
      - trigger: state
        entity_id: sensor.plex_lite_playback
        to: playing
        id: start
      - trigger: state
        entity_id: sensor.plex_lite_playback
        from: playing
        to: [paused, idle]
        id: end
    variables:
      lights: [light.example_ceiling, light.example_lamp]
      kind: "{{ state_attr('sensor.plex_lite_playback', 'kind') }}"
      kids: "{{ state_attr('sensor.plex_lite_playback', 'is_kids') }}"
      live_category: "{{ state_attr('sensor.plex_lite_playback', 'live_category') }}"
    actions:
      - choose:
          - conditions:
              - condition: trigger
                id: start
              - condition: template   # sport: leave the lights as they are
                value_template: "{{ not (kind == 'live' and live_category == 'sports') }}"
              - condition: or         # only when it's dark, or the lights are on anyway
                conditions:
                  - condition: state
                    entity_id: sun.sun
                    state: below_horizon
                  - condition: template
                    value_template: "{{ lights | select('is_state', 'on') | list | count > 0 }}"
            sequence:
              - if:
                  - condition: state
                    entity_id: input_boolean.plex_lite_dimmed
                    state: "off"
                then:
                  - action: scene.create
                    data:
                      scene_id: plex_lite_before
                      snapshot_entities: "{{ lights }}"
              - action: input_boolean.turn_on
                target:
                  entity_id: input_boolean.plex_lite_dimmed
              - action: light.turn_on
                target:
                  entity_id: "{{ lights }}"
                data:
                  transition: 3
                  # films 10 % warm, shows 30 %, Live TV 40 %; never below 40 % for children's content
                  brightness_pct: >
                    {% set b = {'movie': 10, 'series': 30, 'live': 40}.get(kind, 30) %}
                    {{ [b, 40] | max if kids else b }}
                  color_temp_kelvin: "{{ 2200 if kind == 'movie' else 2700 }}"
          - conditions:
              - condition: trigger
                id: end
              - condition: state
                entity_id: input_boolean.plex_lite_dimmed
                state: "on"
            sequence:
              - action: scene.turn_on
                target:
                  entity_id: scene.plex_lite_before
                data:
                  transition: 2
              - action: input_boolean.turn_off
                target:
                  entity_id: input_boolean.plex_lite_dimmed
```

Older Home Assistant versions spell `triggers:`/`trigger:`/`actions:`/`action:` as
`trigger:`/`platform:`/`action:`/`service:`.

Try it without the TV:

```sh
curl -X POST -d 'source=plexlite&event=play&kind=movie&type=movie&title=Test&is_kids=false' \
  http://<Home Assistant>:8123/api/webhook/<id>
curl -X POST -d 'source=plexlite&event=pause' http://<Home Assistant>:8123/api/webhook/<id>
```

## Tests

- `node --test test/home-assistant.test.mjs`: URL checks, routes and the remembered route, the form
  body, Movie mode's debounce and filter, and a run against a fake Home Assistant that handles
  webhooks as Home Assistant does.
- `PLEXLITE_BROWSER_TESTS=1 node --test test/playback-browser.test.mjs`: the real player on the demo
  server in Chrome, with the plugin sending to a fake Home Assistant.
