// The A–Z jump rail on the Library grid: a slim column of letters (#, A–Z) at the right edge. It
// highlights the letter of the focused title, and picking a letter (OK, a click, or the number
// keys like a phone keypad) jumps the grid to that letter's first title.
//
// Where a letter starts comes from Plex: /library/sections/{id}/firstCharacter, asked with the
// grid's own filters, lists each first letter with how many titles start with it, in titleSort
// order. Adding up those counts gives each letter's offset in the title-sorted listing, so a jump
// loads just that window of the grid instead of paging through everything before it.
//
// Performance (1.1 GHz TV): the letters never change after a filter change. Focus and the current
// letter are one small marker that moves on `transform` and swaps between its two looks on
// `opacity`, so moving through the grid or the rail never lays anything out.
'use strict';

(function () {
  var az = PL.az = {};
  var K = PL.KEY;

  az.LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  // ---- The maths (pure; test/az.test.mjs) ----------------------------------------------------

  // A firstCharacter entry's rail slot: '#' or 'A'..'Z'. Plex already folds case and puts digits and
  // punctuation under '#'; accented Latin letters fold onto their base letter. Anything else
  // (another script) has no slot: its titles still count towards the offsets, it just can't be
  // picked from the rail.
  az.slotOf = function (title) {
    var c = String(title == null ? '' : title).charAt(0);
    if (!c) return null;
    if (c.normalize) c = c.normalize('NFD').charAt(0);
    c = c.toUpperCase();
    if (c >= 'A' && c <= 'Z') return c;
    if (c === '#' || (c >= '0' && c <= '9')) return '#';
    if (/[!-\/:-@\[-`{-~]/.test(c)) return '#';
    return null;
  };

  // dirs: the firstCharacter Directory[] ({title, size}) in the server's (ascending) order.
  // desc: the grid is sorted Z–A, which lists the same groups in reverse.
  // Returns {total, desc, ranges: [{slot, start, size}] in list order, starts: {slot: first index}}.
  az.index = function (dirs, desc) {
    var groups = (dirs || []).filter(function (d) { return d && Number(d.size) > 0; });
    if (desc) groups = groups.slice().reverse();
    var ranges = [];
    var starts = {};
    var at = 0;
    groups.forEach(function (d) {
      var size = Number(d.size);
      var slot = az.slotOf(d.title != null ? d.title : d.key);
      ranges.push({ slot: slot, start: at, size: size });
      if (slot && !(slot in starts)) starts[slot] = at;
      at += size;
    });
    return { total: at, desc: !!desc, ranges: ranges, starts: starts };
  };

  // The rail's letters top to bottom: A–Z order, flipped for a Z–A sort so the rail reads like the
  // grid (top of the rail = top of the list).
  az.order = function (model) {
    return model && model.desc ? az.LETTERS.slice().reverse() : az.LETTERS.slice();
  };

  // The first index of a letter, or -1 when no title starts with it.
  az.target = function (model, slot) {
    return model && slot in model.starts ? model.starts[slot] : -1;
  };

  // The slot of the title at `index` (binary search over the ranges); null past the end or in a range
  // without a slot.
  az.slotAt = function (model, index) {
    var r = model ? model.ranges : [];
    var lo = 0;
    var hi = r.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (index < r[mid].start) hi = mid - 1;
      else if (index >= r[mid].start + r[mid].size) lo = mid + 1;
      else return r[mid].slot;
    }
    return null;
  };

  // The next letter with titles from rail position `from` (exclusive) in direction dir (+1 down,
  // -1 up), or null at the end.
  az.step = function (model, order, from, dir) {
    for (var i = from + dir; i >= 0 && i < order.length; i += dir) {
      if (az.target(model, order[i]) >= 0) return order[i];
    }
    return null;
  };

  // Number keys, as on a phone keypad: 2 = ABC ... 9 = WXYZ; 1 and 0 = # (titles starting with a
  // digit or symbol come first anyway).
  az.KEYPAD = ['#', '#', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'];
  az.TAP_MS = 1200;

  // A key code's digit (the remote's number keys, or the top row / numpad on a keyboard), else -1.
  az.digitOf = function (code) {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 96 && code <= 105) return code - 96;
    return -1;
  };

  // Multi-tap: the first press of a key picks its first letter with titles; pressing it again within
  // TAP_MS moves on to the next one (wrapping). Letters without titles are skipped.
  // tap: {digit, slot, at} from the previous press (updated in place).
  // Returns the letter to jump to, or null when none of the key's letters has titles.
  az.tap = function (model, tap, digit, now) {
    var group = az.KEYPAD[digit].split('');
    var live = group.filter(function (s) { return az.target(model, s) >= 0; });
    var again = tap.digit === digit && now - tap.at < az.TAP_MS;
    tap.digit = digit;
    tap.at = now;
    if (!live.length) {
      tap.slot = null;
      return null;
    }
    var i = again ? live.indexOf(tap.slot) : -1;
    tap.slot = live[(i + 1) % live.length];
    return tap.slot;
  };

  // ---- The rail ----------------------------------------------------------------------------------

  var PITCH = 26; // px per letter: 27 letters fill 702 px, from under the filter row to the bottom margin

  // opts: {onPick(slot)}  (a letter was chosen with OK or a click)
  function Rail(opts) {
    this.opts = opts;
    this.el = PL.el('div', 'az-rail');
    this.mark = PL.el('div', 'az-mark');
    this.markCur = PL.el('div', 'az-mark-cur');
    this.markFocus = PL.el('div', 'az-mark-focus');
    this.mark.appendChild(this.markCur);
    this.mark.appendChild(this.markFocus);
    this.el.appendChild(this.mark);
    this.nodes = az.LETTERS.map(function (s, i) {
      var n = PL.el('div', 'az-letter', s);
      n.style.top = (i * PITCH) + 'px';
      var self = this;
      n.addEventListener('click', function () {
        var slot = self.order[i];
        if (az.target(self.model, slot) >= 0) self.opts.onPick(slot);
      });
      this.el.appendChild(n);
      return n;
    }, this);
    this.order = az.LETTERS;
    this.model = null;
    this.current = null; // the focused title's letter
    this.pos = -1; // the rail's own focus (when focused)
    this.focused = false;
    this.shown = false;
    this.markAt = -1;
    this.underAt = -1;
    this.markText = '';
  }

  Rail.prototype.setModel = function (model) {
    this.model = model;
    var order = az.order(model);
    var self = this;
    if (order[0] !== this.order[0]) {
      this.order = order;
      this.nodes.forEach(function (n, i) { n.textContent = order[i]; });
    }
    this.nodes.forEach(function (n, i) { n.classList.toggle('empty', az.target(model, self.order[i]) < 0); });
    this.markAt = -1;
    this.paint();
  };

  // Worth showing: the grid is title-sorted (the caller decides) and its titles span 2+ letters.
  Rail.prototype.usable = function () {
    return !!this.model && Object.keys(this.model.starts).length > 1;
  };

  Rail.prototype.show = function (on) {
    on = !!on && this.usable();
    if (on === this.shown) return;
    this.shown = on;
    this.el.classList.toggle('on', on);
    if (!on) this.setFocused(false);
  };

  Rail.prototype.setCurrent = function (slot) {
    if (slot === this.current) return;
    this.current = slot;
    if (!this.focused) this.paint();
  };

  Rail.prototype.setFocused = function (on) {
    if (on === this.focused) return;
    this.focused = on;
    if (on) {
      var at = this.order.indexOf(this.current);
      if (at < 0 || az.target(this.model, this.current) < 0) {
        var first = az.step(this.model, this.order, -1, 1);
        at = this.order.indexOf(first);
      }
      this.pos = at;
    }
    this.el.classList.toggle('focused', on);
    this.paint();
  };

  // One marker for both looks: a soft pill on the current letter, the white focus plate when the rail
  // has focus. It carries its own copy of the letter (the one underneath is faded out), so no letter
  // ever restyles.
  Rail.prototype.paint = function () {
    var at = this.focused ? this.pos : this.order.indexOf(this.current);
    if (this.underAt !== at) {
      if (this.underAt >= 0) this.nodes[this.underAt].classList.remove('under');
      if (at >= 0) this.nodes[at].classList.add('under');
      this.underAt = at;
    }
    if (at < 0) {
      this.mark.style.opacity = '0';
      this.markAt = -1;
      return;
    }
    var text = this.order[at];
    if (text !== this.markText) {
      this.markText = text;
      this.markCur.textContent = text;
      this.markFocus.textContent = text;
    }
    if (at !== this.markAt) {
      // the first placement lands instead of sliding in from the top
      if (this.markAt < 0) this.mark.classList.add('instant');
      this.markAt = at;
      this.mark.style.transform = 'translate3d(0,' + (at * PITCH) + 'px,0)';
      var mark = this.mark;
      if (mark.classList.contains('instant')) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { mark.classList.remove('instant'); }); });
      }
    }
    this.mark.style.opacity = '1';
  };

  // Up/Down move between letters with titles; OK picks. Anything else is the caller's (Left back to
  // the grid, Up past the top to the filter row).
  Rail.prototype.key = function (code) {
    if (code === K.UP || code === K.DOWN) {
      var next = az.step(this.model, this.order, this.pos, code === K.DOWN ? 1 : -1);
      if (!next) return code === K.DOWN; // Down at the bottom stays; Up at the top leaves
      this.pos = this.order.indexOf(next);
      this.paint();
      return true;
    }
    if (code === K.ENTER) {
      var slot = this.order[this.pos];
      if (slot && az.target(this.model, slot) >= 0) this.opts.onPick(slot);
      return true;
    }
    return false;
  };

  az.Rail = Rail;

  // ---- The jump flash: the letter, large, for a moment after a jump ---------------------------

  // Number keys show their whole group ("P Q R S") with the chosen letter lit, so a second press
  // makes sense before it happens.
  function Flash() {
    this.el = PL.el('div', 'az-flash');
    this.text = PL.el('div', 'az-flash-text');
    this.el.appendChild(this.text);
    this.timer = null;
  }

  // empty(slot): true for a letter without titles (shown fainter)
  Flash.prototype.show = function (letters, lit, empty) {
    PL.clear(this.text);
    var self = this;
    this.text.classList.toggle('group', letters.length > 1);
    letters.forEach(function (s) {
      self.text.appendChild(PL.el('span', s === lit ? 'lit' : empty && empty(s) ? 'empty' : '', s));
    });
    this.el.classList.add('on');
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.el.classList.remove('on'); }, letters.length > 1 ? az.TAP_MS - 200 : 650);
  };

  Flash.prototype.hide = function () {
    clearTimeout(this.timer);
    this.el.classList.remove('on');
  };

  az.Flash = Flash;
})();
