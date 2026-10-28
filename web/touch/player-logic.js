// The touch player's pure decisions (docs/WEB.md, "The touch player"): which third of the picture a
// tap lands in, the double-tap seek accumulator, the scrub bar's finger-to-time mapping, how a pan
// is read (close the player, fine scrub), and when the controls may hide. No DOM, so
// test/touch-player.test.mjs runs it in Node. Web build only (web/touch/ may use modern JS).
'use strict';

(() => {
  const PL = window.PL = window.PL || {};
  const G = PL.touchPlayerLogic = {};

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Double-tap steps match the remote's Left / Right (the owner's choice): back 10 s, ahead 30 s.
  G.STEP_BACK = 10;
  G.STEP_FWD = 30;
  G.DOUBLE_MS = 260;  // a second tap on the same side within this is a double tap
  G.STREAK_MS = 700;  // after a double tap, each tap within this of the last adds another step
  G.HIDE_MS = 4000;   // the controls hide after this while playing
  G.PAN_SLOP = 10;    // px a finger moves before a press becomes a pan
  G.CLOSE_PX = 96;    // a pull down this far closes the player
  G.FINE_RATE = 0.25; // a sideways drag on the picture scrubs at a quarter of the bar's rate

  // The picture in thirds: 'back' (left), 'mid', 'fwd' (right).
  G.zoneAt = (x, width) => (x < width / 3 ? 'back' : x > (width * 2) / 3 ? 'fwd' : 'mid');

  // ---- Taps: single (controls), double and more (seek) ----------------------------------------------

  // state: null, or {at, zone, streak: null | {dir, count, total}} (what the last tap left).
  // tap: {t (ms), x, width}. Returns {state, act}; act.type:
  //   'wait'   a first tap on a side: wait DOUBLE_MS for a second before it counts as a single tap
  //            (settle() says so); the middle third toggles at once (no double tap there)
  //   'toggle' show or hide the controls
  //   'seek'   {dir: -1 | 1, step, count, total}: seek by `step` now; `total` is the streak so far
  //            (the ripple's label). A tap on the other side mid-streak starts a streak there.
  G.tap = (state, tap) => {
    const zone = G.zoneAt(tap.x, tap.width);
    const s = state;
    const side = zone !== 'mid';
    const dir = zone === 'back' ? -1 : 1;
    const step = dir < 0 ? G.STEP_BACK : G.STEP_FWD;
    if (side && s && s.streak && tap.t - s.at <= G.STREAK_MS) {
      const same = s.streak.dir === dir;
      const streak = { dir, count: same ? s.streak.count + 1 : 1, total: (same ? s.streak.total : 0) + step };
      return { state: { at: tap.t, zone, streak }, act: { type: 'seek', dir, step, count: streak.count, total: streak.total } };
    }
    if (side && s && !s.streak && s.zone === zone && tap.t - s.at <= G.DOUBLE_MS) {
      const streak = { dir, count: 1, total: step };
      return { state: { at: tap.t, zone, streak }, act: { type: 'seek', dir, step, count: 1, total: step } };
    }
    if (!side) return { state: null, act: { type: 'toggle' } };
    return { state: { at: tap.t, zone, streak: null }, act: { type: 'wait', ms: G.DOUBLE_MS } };
  };

  // When the timer set by a 'wait' or a 'seek' fires (t: now). -> {state, act: 'toggle' | 'end' | null}
  // 'toggle': the lone tap was a single tap. 'end': the seek streak is over (the ripple goes).
  G.settle = (state, t) => {
    if (!state) return { state: null, act: null };
    if (!state.streak) return t - state.at >= G.DOUBLE_MS ? { state: null, act: 'toggle' } : { state, act: null };
    return t - state.at >= G.STREAK_MS ? { state: null, act: 'end' } : { state, act: null };
  };

  // The ripple's label: "−20 s", "+60 s" (minutes past 90 s: "+2 min").
  G.seekLabel = (dir, total) => {
    const sign = dir < 0 ? '−' : '+';
    return sign + (total >= 120 && total % 60 === 0 ? total / 60 + ' min' : total + ' s');
  };

  // ---- The bar: the finger to a time --------------------------------------------------------------

  // segs: the bar's segments (PL.playerLogic.segments for the bar's width in px); x: the finger,
  // px from the bar's left edge (off either end clamps). L: PL.playerLogic. -> seconds, kept 5 s
  // short of the end (as the TV's seeks).
  G.scrubSec = (L, segs, x, width, dur) => {
    if (!(dur > 0) || !(width > 0)) return 0;
    return clamp(L.secAt(segs, clamp(x, 0, width)), 0, Math.max(0, dur - 5));
  };

  // Where the time label sits over the bar: centred on the finger, kept within `edge` px of the
  // bar's ends. -> its left, px from the bar's left edge.
  G.labelLeft = (x, labelW, barW, edge = 0) => clamp(x - labelW / 2, 0 - edge, Math.max(0 - edge, barW - labelW + edge));

  // A sideways drag on the picture with the controls up: a finer scrub than the bar (FINE_RATE of
  // the bar's seconds per px). -> the target in seconds.
  G.fineScrub = (fromSec, dx, barW, dur) => {
    if (!(dur > 0) || !(barW > 0)) return fromSec;
    return clamp(fromSec + (dx * dur * G.FINE_RATE) / barW, 0, Math.max(0, dur - 5));
  };

  // ---- Pans on the picture --------------------------------------------------------------------------

  // What a moving finger is doing, decided once it has moved PAN_SLOP: 'down' (pulling the player
  // down to close it), 'side' (a fine scrub, only with the controls up), 'none' (up, or sideways
  // with the controls hidden: ignored), or null (not moved enough yet).
  G.panKind = (dx, dy, controlsUp) => {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (Math.max(ax, ay) < G.PAN_SLOP) return null;
    if (ay > ax) return dy > 0 ? 'down' : 'none';
    return controlsUp ? 'side' : 'none';
  };

  // A pull down closes the player when it went far enough, or was a quick flick (v: px per ms).
  G.closes = (dy, v) => dy >= G.CLOSE_PX || (dy >= 32 && v > 0.5);

  // ---- The controls ----------------------------------------------------------------------------------

  // They hide by themselves only while playing, and never while the finger is on the bar, a sheet
  // or a tab's panel is open (landscape), the end card shows, or the player is locked (the lock
  // hides them anyway).
  G.mayHide = (c) => !!c.playing && !c.scrubbing && !c.sheet && !c.pane && !c.endcard && !c.error;

  // A restartable timer for the controls. opts: {ms, schedule(fn, ms) -> id, cancel(id), hide()}.
  // poke(c) (after any touch, and when the state changes): re-arms it if the controls may hide,
  // else stops it. When it fires it checks again (the state may have changed meanwhile).
  G.hideTimer = (opts) => {
    let id = null;
    let last = null;
    const cancel = () => { if (id != null) opts.cancel(id); id = null; };
    return {
      poke(c) {
        last = c;
        cancel();
        if (!G.mayHide(c)) return false;
        id = opts.schedule(() => {
          id = null;
          const now = opts.check ? opts.check() : last;
          if (G.mayHide(now)) opts.hide();
        }, opts.ms == null ? G.HIDE_MS : opts.ms);
        return true;
      },
      cancel,
      armed: () => id != null,
    };
  };

  // ---- Layout -----------------------------------------------------------------------------------------

  // Landscape (full-bleed picture, the tabs open over it) when the window is wider than tall.
  G.landscape = (w, h) => w > h;

  // The tabs under the bar, in the boards' order: portrait (P3) puts the browsable rows first and
  // opens the first; landscape (L1) reads Info first and opens none until tapped.
  G.tabOrder = (ids, landscape) => {
    const order = landscape ? ['info', 'cast', 'chapters', 'episodes'] : ['episodes', 'chapters', 'cast', 'info'];
    return order.filter((id) => ids.indexOf(id) >= 0);
  };
})();
