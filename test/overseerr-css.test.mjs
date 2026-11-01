// The Overseerr page's danger row ("Sign out of Overseerr", plugins/overseerr/overseerr.css): light
// red on the dark ground, dark red only on the focused (white) plate, so the unfocused row is readable.
//   node --test test/overseerr-css.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../plugins/overseerr/overseerr.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// [selector, color] for every rule that colours a danger row's label
function dangerRules() {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const color = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(m[2]);
    if (!color) continue;
    m[1].split(',').map((x) => x.trim()).filter((sel) => /osp-danger/.test(sel) && /osp-label/.test(sel)).forEach((sel) => out.push([sel, color[1].trim()]));
  }
  return out;
}

// how a browser picks between them: the more specific selector, else the later rule
const specificity = (sel) => (sel.match(/\.[\w-]+/g) || []).length;

test('overseerr page: an unfocused Sign out row keeps its light red label; dark red only when focused', () => {
  const rules = dangerRules();
  const unfocused = rules.filter(([sel]) => !/\.focused/.test(sel));
  assert.ok(unfocused.length, 'a rule for the unfocused row');
  // the rule that wins for an unfocused row: the most specific, the last of equals
  const win = unfocused.reduce((a, b) => (specificity(b[0]) >= specificity(a[0]) ? b : a));
  assert.equal(win[1].toLowerCase(), '#ff8a80', 'readable on the dark ground');
  const focused = rules.filter(([sel]) => /\.focused/.test(sel));
  assert.ok(focused.some(([, c]) => c.toLowerCase() === '#b3261e'), 'dark red on the white plate');
});
