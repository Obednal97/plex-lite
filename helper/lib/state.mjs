// The helper's small persisted state: which Seerr issues it has handled (live and dry-run apart,
// so a dry-run look at an issue doesn't stop the live run from fixing it later) and the rolling
// windows behind the re-grab limits. One JSON file, written atomically.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 24 * 3600 * 1000;
const KEEP_HANDLED = 5000;

export function openState(dir, now = () => Date.now(), log = () => {}) {
  const file = join(dir, 'state.json');
  let data = { version: 1, handled: {}, dryRunHandled: {}, regrabs: [], reports: [] };
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      data = { ...data, ...parsed };
    }
  } catch (e) {
    // a corrupt file must not let issues be processed twice: refuse to start
    throw new Error(`state file ${file} is unreadable (${e.message}); fix or move it before starting`);
  }

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
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1));
    renameSync(tmp, file);
  }

  return {
    file,
    get data() { return data; },
    isHandled(id, dryRun) {
      return !!data.handled[id] || (dryRun && !!data.dryRunHandled[id]);
    },
    // recorded before the first destructive call, and before any comment
    markHandled(id, dryRun, outcome) {
      (dryRun ? data.dryRunHandled : data.handled)[id] = { at: now(), outcome };
      save();
    },
    setOutcome(id, dryRun, outcome) {
      const rec = (dryRun ? data.dryRunHandled : data.handled)[id];
      if (rec) { rec.outcome = outcome; save(); }
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
