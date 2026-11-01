// The helper's small persisted state: which Seerr issues it has handled (live and dry-run apart,
// so a dry-run look at an issue doesn't stop the live run from fixing it later), how far a live
// fix got (so one interrupted by a crash or restart is reported, not forgotten), and the rolling
// windows behind the re-grab limits. One JSON file, written atomically (fsync, then rename).
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const DAY = 24 * 3600 * 1000;
const KEEP_HANDLED = 5000;
export const CORRUPT_PREFIX = 'state.json.corrupt-';

export function openState(dir, now = () => Date.now(), log = () => {}) {
  const file = join(dir, 'state.json');
  let data = { version: 1, handled: {}, dryRunHandled: {}, regrabs: [], reports: [] };
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      data = { ...data, ...parsed };
    } catch (e) {
      // Don't restart-loop and don't go live without memory: move it aside; while a
      // state.json.corrupt-* file is in the folder the helper stays in dry run (see app.mjs).
      const aside = join(dir, `${CORRUPT_PREFIX}${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
      renameSync(file, aside);
      log(`!!! state.json was unreadable (${e.message}): moved to ${aside}. Starting with an empty state IN DRY RUN. ` +
        'Restore it or delete the .corrupt file to go live again.');
    }
  }
  const corruptFiles = () => readdirSync(dir).filter((f) => f.startsWith(CORRUPT_PREFIX));

  function prune() {
    const t = now();
    data.regrabs = data.regrabs.filter((r) => t - r.at < 7 * DAY);
    data.reports = data.reports.filter((r) => t - r.at < 7 * DAY);
    for (const key of ['handled', 'dryRunHandled']) {
      const ids = Object.keys(data[key]);
      if (ids.length > KEEP_HANDLED) {
        ids.sort((a, b) => data[key][a].at - data[key][b].at);
        for (const id of ids.slice(0, ids.length - KEEP_HANDLED)) delete data[key][id];
      }
    }
  }

  function save() {
    prune();
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(data, null, 1));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, file);
    try { const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not on every OS */ }
  }

  const table = (dryRun) => (dryRun ? data.dryRunHandled : data.handled);

  return {
    file,
    corruptFiles,
    get data() { return data; },
    isHandled(id, dryRun) {
      return !!data.handled[id] || (dryRun && !!data.dryRunHandled[id]);
    },
    // recorded before the first destructive call, and before any comment
    markHandled(id, dryRun, outcome, extra = {}) {
      table(dryRun)[id] = { at: now(), outcome, step: 'checking', ...extra };
      save();
    },
    unmarkHandled(id, dryRun) {
      delete table(dryRun)[id];
      save();
    },
    setOutcome(id, dryRun, outcome) {
      const rec = table(dryRun)[id];
      if (rec) { rec.outcome = outcome; save(); }
    },
    // how far a live fix got: blocklisting → blocklisted → deleting → deleted → searching → searched
    setStep(id, dryRun, step, extra = {}) {
      const rec = table(dryRun)[id];
      if (rec) { Object.assign(rec, extra, { step }); save(); }
    },
    // live issues a crash or kill left half-way
    interrupted() {
      return Object.entries(data.handled).filter(([, r]) => r.outcome === 'started').map(([id, r]) => ({ id: Number(id), ...r }));
    },
    regrabCounts(userId, titleKey) {
      const t = now();
      const day = data.regrabs.filter((r) => t - r.at < DAY);
      return {
        user24h: day.filter((r) => r.user === userId).length,
        total24h: day.length,
        title7d: data.regrabs.filter((r) => r.title === titleKey && t - r.at < 7 * DAY).length,
      };
    },
    recordRegrab(userId, titleKey, issueId) {
      data.regrabs.push({ at: now(), user: userId, title: titleKey, issue: issueId });
      save();
    },
    // earlier live reports on the same thing, for "second wrong-item" / "second wrong language"
    priorReports(reason, key, withinMs = 7 * DAY) {
      const t = now();
      return data.reports.filter((r) => r.reason === reason && r.key === key && t - r.at < withinMs);
    },
    recordReport(reason, key, issueId) {
      data.reports.push({ at: now(), reason, key, issue: issueId });
      save();
    },
    save,
  };
}
