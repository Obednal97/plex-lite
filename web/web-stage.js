// The web build's stage size and artwork sizes (docs/WEB.md, "The window"): pure decisions, tested
// in test/web-stage.test.mjs. web/web.js applies them. Loaded only by the web build, before
// web/web.js; ES2015 like the rest.
'use strict';

(function () {
  var PL = window.PL = window.PL || {};

  var TV_W = 1920;
  // the desk view's narrowest stage: the TV's screens are laid out for 1920 and hold down to this
  // (web/web.css moves what is centred or at the right edge; the library grid drops a column)
  var DESK_MIN_W = 1600;
  var MIN_H = 900;
  var MAX_H = 1440;
  // laptop and desktop: one stage px is this many CSS px by default (body text 26 -> 17 px, a poster
  // 250 -> 163 px). Settings -> Size on this screen moves it between DESK_MIN and DESK_MAX in DESK_STEP
  // steps, per browser (PL.storage 'deskScale').
  var DESK = 0.65;
  var DESK_MIN = 0.5;
  var DESK_MAX = 0.85;
  var DESK_STEP = 0.05;
  // from this stage width on, the stage stops growing and scales up with the window instead
  var DESK_MAX_W = 3840;

  // The size setting as stored (a number, or anything a hand-edited or older localStorage holds):
  // a valid density on the step grid, else the default.
  function density(v) {
    var n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    if (!isFinite(n)) return DESK;
    n = Math.min(DESK_MAX, Math.max(DESK_MIN, n));
    return Math.round(Math.round(n / DESK_STEP) * DESK_STEP * 100) / 100;
  }

  // One step smaller (dir -1) or larger (+1), within the bounds.
  function stepDensity(v, dir) {
    return density(density(v) + (dir < 0 ? -DESK_STEP : DESK_STEP));
  }

  // The density as people read it: a percentage of the default size (0.65 -> 100%).
  function percent(v) {
    return Math.round((density(v) / DESK) * 100);
  }

  // The stage for a window of w x h CSS px.
  //   desk (a laptop or desktop with a mouse): one stage px is `dens` CSS px (DESK by default), like
  //     any web page, and the stage is as wide and as tall as the window then holds. A bigger window, or zooming the browser
  //     out, shows more; zooming in makes everything bigger. Never narrower than DESK_MIN_W or
  //     shorter than 900 stage px (it scales down to fit instead); past DESK_MAX_W wide it scales up with the
  //     window instead of growing (unless the window is also very short). No bars.
  //   otherwise (the 10-foot view): the TV's 1920 px wide stage scaled to the window's width, as tall
  //     as the window holds (900 to 1440); narrower than 4:3 the 1920x1080 stage fitted with bars.
  // -> {w, h, scale, x, y}: stage px, CSS px per stage px, and the stage's offset in the window.
  function size(w, h, desk, dens) {
    var s;
    var H;
    if (desk) {
      s = Math.min(Math.max(dens == null ? DESK : density(dens), w / DESK_MAX_W), w / DESK_MIN_W, h / MIN_H);
      var W = Math.max(DESK_MIN_W, Math.round(w / s));
      s = w / W;
      return { w: W, h: Math.max(MIN_H, Math.round(h / s)), scale: s, x: 0, y: 0 };
    }
    s = w / TV_W;
    H = h / s;
    if (H < MIN_H) {
      H = MIN_H;
      s = h / MIN_H;
    } else if (H > MAX_H) {
      H = 1080;
      s = Math.min(w / TV_W, h / 1080);
    }
    H = Math.round(H);
    return { w: TV_W, h: H, scale: s, x: Math.round((w - TV_W * s) / 2), y: Math.max(0, Math.round((h - H * s) / 2)) };
  }

  // How much bigger than asked to fetch a Plex image. Callers ask Plex's photo transcoder for a
  // card's size in stage px (1:1 on the TV). A browser draws a stage px at scale x devicePixelRatio
  // device pixels, so a Retina laptop needs more. The factor goes up in steps so the server's and the
  // browser's caches still hit, and never below 1 (the TV's size). Full-screen art (the hero and
  // details backgrounds, asked for at 1280 or 1920 wide and drawn across the window) is fetched at
  // the window's width in device pixels, in steps up to 3840. Blurred art stays as asked: the blur
  // hides the difference.
  // width: what the caller asked for; blur: whether it is blurred; scale: the stage's; dpr; winW: CSS px
  var STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
  var WIDE_STEPS = [1280, 1920, 2560, 3200, 3840];
  function step(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i] >= v - 0.01) return list[i];
    return list[list.length - 1];
  }
  function imageScale(width, blur, scale, dpr, winW) {
    if (blur) return 1;
    dpr = dpr || 1;
    if (width >= 1280) return Math.max(1, step(WIDE_STEPS, winW * dpr) / width);
    return step(STEPS, (scale || 1) * dpr);
  }

  PL.webStage = {
    TV_W: TV_W, DESK_MIN_W: DESK_MIN_W, DESK: DESK, DESK_MIN: DESK_MIN, DESK_MAX: DESK_MAX, DESK_STEP: DESK_STEP,
    size: size, density: density, stepDensity: stepDensity, percent: percent, imageScale: imageScale,
  };
})();
