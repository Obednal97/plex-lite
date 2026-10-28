// Channel logos on their plate (the guide's channel column, Search's Live TV rows). Most logos are
// dark or colourful and sit on a light plate, but some are white on a transparent background and
// vanish on it. Each logo is looked at once, in a 32x16 canvas: when it has a transparent background
// and more of it would be lost on the light plate than on a dark one (logos.tone), its plate turns
// dark (`logo-dark`). Plex answers
// image requests with Access-Control-Allow-Origin (the app's file:// origin is "null"), so the
// canvas can be read; if a server doesn't, the logo loads again without CORS on a mid-grey plate
// (`logo-mid`) that shows white and dark logos alike. CSS: css/logos.css.
'use strict';

(function () {
  var logos = PL.logos = {};
  var tones = {}; // logo path -> 'light' | 'dark' | 'mid' (this session; the path holds no token)
  var canvas = null;
  var W = 32;
  var H = 16;

  // RGBA bytes -> 'light' (needs the dark plate) or 'dark' (the light plate is fine). Pure; tested.
  // Counts the visible pixels each plate would lose: bright ones (white, silver, pale yellow, pastel)
  // on the light plate, ones with no bright channel at all (black, navy, dark green) on the dark one.
  // Saturated colours (red, orange, green, blue) show on both and count for neither. A logo with its
  // own background (under 10% transparent) keeps the light plate.
  logos.tone = function (data) {
    var seen = 0;
    var clear = 0;
    var bright = 0;
    var dark = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 96) { clear++; continue; }
      seen++;
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      if (0.2126 * r + 0.7152 * g + 0.0722 * b > 190) bright++;
      else if (Math.max(r, g, b) < 140) dark++;
    }
    if (!seen || clear < data.length / 4 * 0.1) return 'dark';
    return bright >= seen * 0.15 && dark < bright * 0.5 ? 'light' : 'dark';
  };

  function measure(img) {
    try {
      canvas = canvas || document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      return logos.tone(ctx.getImageData(0, 0, W, H).data);
    } catch (e) {
      return 'mid'; // a tainted canvas: no CORS after all
    }
  }

  function paint(plate, tone) {
    plate.classList.toggle('logo-dark', tone === 'light');
    plate.classList.toggle('logo-mid', tone === 'mid');
    plate.classList.add('loaded');
  }

  // Puts the channel's logo (or its name, when there is none or it fails) in `plate`.
  // opts: {w, h (the image's size), textClass (the name fallback's class), label (its text; the name)}
  logos.fill = function (plate, c, opts) {
    var text = function () { plate.appendChild(PL.el('span', opts.textClass, opts.label != null ? opts.label : c.name)); };
    var src = c.thumb ? PL.plex.image(c.thumb, opts.w, opts.h, { format: 'png' }) : null;
    if (!src) return text();
    var img = PL.el('img');
    img.width = opts.w;
    img.height = opts.h;
    var known = tones[c.thumb];
    var cors = known !== 'mid';
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = function () {
      if (!tones[c.thumb]) tones[c.thumb] = measure(img);
      paint(plate, tones[c.thumb]);
    };
    img.onerror = function () {
      if (cors) {
        // refused with CORS: once more without (the plate goes mid-grey)
        cors = false;
        tones[c.thumb] = 'mid';
        img.removeAttribute('crossorigin');
        img.src = src;
        return;
      }
      img.style.visibility = 'hidden';
      text();
    };
    img.src = src;
    plate.appendChild(img);
    return img;
  };
})();
