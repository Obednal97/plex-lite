#!/usr/bin/env node
// DevTools-protocol client for web apps running on the TV (WAM listens on :9998).
// Needs a tunnel: ssh -f -N -L 19998:127.0.0.1:9998 lgtv
//
//   node tools/tvdebug.mjs list
//   node tools/tvdebug.mjs eval '<js expression>'      [--match <url substring>]
//   node tools/tvdebug.mjs logs <seconds>
//   node tools/tvdebug.mjs keys <key> [<key> ...]       keys: up down left right enter back play pause, or ms:<n> to wait
//   node tools/tvdebug.mjs trace <seconds> [--keys "right right down ..."] [--out file.json]
//   node tools/tvdebug.mjs shot <file.png>
//   node tools/tvdebug.mjs mouse <x> <y> [click] [wheel:<dy>]
//   node tools/tvdebug.mjs reload

import { writeFileSync } from 'node:fs';

const PORT = process.env.TVDEBUG_PORT || 19998;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const match = opt('match', 'plexlite');
const out = opt('out', null);
const traceKeys = opt('keys', '');
const [cmd, ...rest] = args;

const KEYS = {
  up: 38, down: 40, left: 37, right: 39, enter: 13, back: 461,
  play: 415, pause: 19, stop: 413, ff: 417, rew: 412, red: 403, green: 404, yellow: 405, blue: 406,
};

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function connect() {
  const list = (await targets()).filter((t) => t.type === 'page');
  const t = list.find((x) => x.url.includes(match)) || (match === 'any' ? list[0] : null);
  if (!t) throw new Error(`no page matching "${match}". Pages: ${list.map((x) => x.url).join(', ')}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket failed (is DevTools open elsewhere?)')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(`${m.error.message} ${m.error.data || ''}`)) : res(m.result);
    } else if (m.method) {
      listeners.forEach((fn) => fn(m));
    }
  };
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close(), target: t };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pressKeys(c, list) {
  for (const k of list) {
    if (k.startsWith('ms:')) { await sleep(Number(k.slice(3))); continue; }
    // named keys, single letters/digits ("a", "7"), or raw codes ("k403")
    let code = KEYS[k];
    if (!code && /^[a-z0-9]$/.test(k)) code = k.toUpperCase().charCodeAt(0);
    if (!code && /^k\d+$/.test(k)) code = Number(k.slice(1));
    if (!code) throw new Error(`unknown key ${k}`);
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await sleep(Number(process.env.KEY_GAP || 250));
  }
}

function fmtArg(a) {
  if (a.type === 'string') return a.value;
  if ('value' in a) return JSON.stringify(a.value);
  return a.description || a.type;
}

function summarizeTrace(events) {
  const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
  const byName = new Map();
  for (const e of complete) {
    const k = e.name;
    const s = byName.get(k) || { total: 0, count: 0, max: 0 };
    s.total += e.dur; s.count++; s.max = Math.max(s.max, e.dur);
    byName.set(k, s);
  }
  const interesting = ['FunctionCall', 'EventDispatch', 'Layout', 'UpdateLayoutTree', 'RecalculateStyles', 'UpdateLayerTree',
    'Paint', 'PaintImage', 'CompositeLayers', 'Decode Image', 'ImageDecodeTask', 'RasterTask', 'ParseHTML', 'GCEvent',
    'MinorGC', 'MajorGC', 'V8.GCScavenger', 'TimerFire', 'FireAnimationFrame', 'XHRReadyStateChange', 'ResourceReceivedData'];
  console.log('main-thread work (ms): name  total  count  max');
  [...byName.entries()]
    .filter(([n]) => interesting.includes(n))
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([n, s]) => console.log(`  ${n.padEnd(22)} ${(s.total / 1000).toFixed(1).padStart(8)} ${String(s.count).padStart(6)} ${(s.max / 1000).toFixed(1).padStart(7)}`));
  const tasks = complete.filter((e) => /^(TaskQueueManager::ProcessTaskFromWorkQueue|ThreadControllerImpl::RunTask|MessageLoop::RunTask)$/.test(e.name));
  const mainTid = (() => {
    const t = events.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
    return t ? t.tid : null;
  })();
  const mainTasks = mainTid == null ? tasks : tasks.filter((e) => e.tid === mainTid);
  const long = mainTasks.filter((e) => e.dur > 50000);
  console.log(`main-thread tasks: ${mainTasks.length}, over 50ms: ${long.length}, longest: ${(Math.max(0, ...mainTasks.map((e) => e.dur)) / 1000).toFixed(1)}ms`);
  const frames = events.filter((e) => e.name === 'DrawFrame' || e.name === 'BeginFrame');
  const draws = events.filter((e) => e.name === 'DrawFrame').map((e) => e.ts).sort((a, b) => a - b);
  if (draws.length > 1) {
    const gaps = draws.slice(1).map((t, i) => (t - draws[i]) / 1000);
    const janky = gaps.filter((g) => g > 50).length;
    console.log(`frames drawn: ${draws.length}, gaps over 50ms: ${janky}, worst gap: ${Math.max(...gaps).toFixed(0)}ms`);
  } else {
    console.log(`frame events: ${frames.length}`);
  }
  const userMarks = events.filter((e) => e.cat && e.cat.includes('blink.user_timing'));
  if (userMarks.length) {
    console.log('user timing:');
    userMarks.filter((e) => e.ph === 'R' || e.ph === 'I' || e.ph === 'b' || e.ph === 'e' || e.ph === 'X')
      .slice(0, 40).forEach((e) => console.log(`  ${e.ph} ${e.name}`));
  }
}

async function main() {
  if (cmd === 'list') {
    (await targets()).forEach((t) => console.log(t.type, '|', t.title, '|', t.url));
    return;
  }
  const c = await connect();
  try {
    if (cmd === 'eval') {
      // Chrome 53 has no awaitPromise, so promise results are parked on window and polled.
      const slot = `__tvdbg${Date.now()}`;
      const wrapped = `(function(){var v=(${rest.join(' ')});` +
        `if(v&&typeof v.then==='function'){window.${slot}={pending:true};` +
        `v.then(function(x){window.${slot}={value:x}},function(e){window.${slot}={error:String(e&&e.stack||e)}});return '${slot}';}` +
        `return {__now:true,value:v};})()`;
      let r = await c.send('Runtime.evaluate', { expression: wrapped, returnByValue: true });
      if (!r.exceptionDetails && r.result.value === slot) {
        const deadline = Date.now() + Number(process.env.EVAL_TIMEOUT || 120000);
        for (;;) {
          await sleep(400);
          const p = await c.send('Runtime.evaluate', { expression: `window.${slot}`, returnByValue: true });
          const s = p.result.value || {};
          if (!s.pending) {
            await c.send('Runtime.evaluate', { expression: `delete window.${slot}` });
            if (s.error) { console.error('rejected:', s.error); process.exitCode = 1; return; }
            r = { result: { value: s.value } };
            break;
          }
          if (Date.now() > deadline) throw new Error('promise did not settle in time');
        }
      } else if (!r.exceptionDetails) {
        r = { result: { value: r.result.value.value } };
      }
      if (r.exceptionDetails) {
        console.error('exception:', r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
        process.exitCode = 1;
      } else {
        const v = r.result.value;
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      }
    } else if (cmd === 'logs') {
      c.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled') console.log(`[${m.params.type}]`, m.params.args.map(fmtArg).join(' '));
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          console.log('[EXCEPTION]', d.exception ? d.exception.description : d.text, d.url || '', d.lineNumber || '');
        }
        if (m.method === 'Log.entryAdded') console.log(`[log:${m.params.entry.level}]`, m.params.entry.text, m.params.entry.url || '');
      });
      await c.send('Runtime.enable');
      await c.send('Log.enable').catch(() => {});
      await sleep(Number(rest[0] || 10) * 1000);
    } else if (cmd === 'keys') {
      await pressKeys(c, rest);
    } else if (cmd === 'mouse') {
      // mouse <x> <y> [click] [wheel:<dy>]
      const [x, y] = [Number(rest[0]), Number(rest[1])];
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      for (const extra of rest.slice(2)) {
        if (extra === 'click') {
          await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else if (extra.startsWith('wheel:')) {
          await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(extra.slice(6)) });
        }
      }
    } else if (cmd === 'trace') {
      const events = [];
      let done;
      const finished = new Promise((r) => { done = r; });
      c.on((m) => {
        if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
        if (m.method === 'Tracing.tracingComplete') done();
      });
      await c.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,toplevel,v8,cc,gpu,benchmark',
        options: 'record-until-full',
      });
      const secs = Number(rest[0] || 5);
      if (traceKeys) await Promise.all([pressKeys(c, traceKeys.split(/\s+/).filter(Boolean)), sleep(secs * 1000)]);
      else await sleep(secs * 1000);
      await c.send('Tracing.end');
      await Promise.race([finished, sleep(60000).then(() => { throw new Error('trace collection timed out'); })]);
      if (out) writeFileSync(out, JSON.stringify({ traceEvents: events }));
      summarizeTrace(events);
    } else if (cmd === 'shot') {
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(rest[0] || 'shot.png', Buffer.from(r.data, 'base64'));
      console.log('saved', rest[0] || 'shot.png');
    } else if (cmd === 'reload') {
      await c.send('Page.reload', { ignoreCache: true });
    } else {
      console.log('commands: list | eval <js> | logs <s> | keys <k...> | trace <s> [--keys ".."] [--out f] | shot <f> | reload');
    }
  } finally {
    c.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
