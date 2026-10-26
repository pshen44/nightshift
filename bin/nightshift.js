#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync, exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Shift } from '../src/shift.js';
import { Board, COLUMNS } from '../src/board.js';
import { serve } from '../src/server.js';

const HELP = `nightshift: an AI dev team that works your backlog while you sleep.

  nightshift init                 set up .nightshift/ in this git repo
  nightshift add "title" [body]   put a card on the backlog
  nightshift run [options]        start the shift (dashboard on http://localhost:4242)
  nightshift status               print the board
  nightshift demo                 watch a full shift with mock agents (no tokens, no setup)

run options:
  --forever          keep waiting for new cards instead of stopping when done
  --max-tasks <n>    stop after n cards (default 10)
  --budget <usd>     stop after this much reported spend (default 25)
  --test <cmd>       command that must pass before review, e.g. "npm test"
  --no-scout         never invent cards; only work the ones you wrote
  --port <n>         dashboard port (default 4242), --no-dashboard to skip it
  --mock             fake agents, for trying things out
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    forever: { type: 'boolean' },
    'max-tasks': { type: 'string' },
    budget: { type: 'string' },
    test: { type: 'string' },
    'no-scout': { type: 'boolean' },
    port: { type: 'string' },
    'no-dashboard': { type: 'boolean' },
    mock: { type: 'boolean' },
    open: { type: 'boolean' },
    'no-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...rest] = positionals;
const repoRoot = (cwd = process.cwd()) => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    die('Run this inside a git repository.');
  }
};
function die(msg) {
  console.error(`nightshift: ${msg}`);
  process.exit(1);
}

const MISSION = `# Mission

<!-- Every agent reads this first, every run. It is the context your routines never had. -->

## What this project is
One paragraph: what it does, who uses it, what stack it's on.

## Where it's going
- The 2-3 outcomes that matter most right now.

## Map
- \`src/\`: ...
- How to run tests: ...

## Rules
- Things agents must never do (touch payments, change the public API, add dependencies, ...).
- House style worth knowing.
`;

function init(root) {
  const ns = path.join(root, '.nightshift');
  new Board(path.join(ns, 'board'));
  const write = (f, s) => fs.existsSync(path.join(ns, f)) || fs.writeFileSync(path.join(ns, f), s);
  write('MISSION.md', MISSION);
  write('journal.md', '# Journal\n\nnightshift appends what each card shipped or why it blocked. Agents read the tail every run.\n');
  write('config.json', JSON.stringify({ test: null, maxTasks: 10, budgetUsd: 25, scout: { enabled: true, batch: 3 } }, null, 2) + '\n');
  write('.gitignore', 'worktrees/\n');
  return ns;
}

async function run(root, overrides, { mock, dashboard = true, port = 4242, open } = {}) {
  if (!mock) {
    try { execFileSync('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }); }
    catch { die('Claude Code CLI not found. Install it: https://docs.claude.com/claude-code'); }
  }
  if (!fs.existsSync(path.join(root, '.nightshift'))) die('No .nightshift/ here yet. Run `nightshift init` first.');
  const shift = new Shift(root, { mock, ...overrides });
  shift.on('feed', (l) => console.log(`${new Date(l.t).toTimeString().slice(0, 8)} ${l.phase.padEnd(7)} ${l.kind === 'error' ? '!' : ' '} ${l.text.split('\n')[0].slice(0, 140)}`));

  if (dashboard) {
    await serve(shift, port);
    const url = `http://localhost:${port}`;
    console.log(`\n  nightshift control room: ${url}\n`);
    if (open) exec(process.platform === 'win32' ? `start "" ${url}` : `${process.platform === 'darwin' ? 'open' : 'xdg-open'} ${url}`);
  }
  let interrupts = 0;
  process.on('SIGINT', () => {
    if (++interrupts > 1) process.exit(130);
    console.log('\nFinishing the current step, then stopping. Ctrl+C again to quit now.');
    shift.stop();
  });
  try {
    await shift.run();
  } catch (e) {
    die(e.message);
  }
  if (dashboard) console.log('Dashboard stays up. Ctrl+C to exit.');
  else process.exit(0);
}

async function demo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightshift-demo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'nightshift demo');
  g('config', 'user.email', 'demo@nightshift.local');
  fs.writeFileSync(path.join(dir, 'README.md'), '# todo-api\n\nA tiny todo API.\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const ns = init(dir);
  fs.writeFileSync(path.join(ns, 'MISSION.md'), '# Mission\n\nA tiny todo API that people can self-host in one command.\n');
  const b = new Board(path.join(ns, 'board'));
  b.add('Add a /health endpoint', 'Return 200 and the version.\n\nDone when: GET /health returns {"ok":true}.');
  b.add('Paginate GET /todos', 'Large lists time out.\n\nDone when: ?limit and ?cursor work and are tested. [mock:changes]');
  b.add('Pick a default storage backend', 'SQLite or flat JSON file?\n\n[mock:question]');
  b.add('Rate-limit the write endpoints', 'Stop one client from flooding us.\n\nDone when: 429 after 60 writes/min per IP.');
  console.log(`Demo repo: ${dir}`);
  await run(dir, { test: 'node -e "process.exit(0)"', maxTasks: 12, mockDelay: 700 }, { mock: true, open: !o['no-open'], port: Number(o.port ?? 4242) });
}

if (o.help || !cmd) {
  console.log(HELP);
} else if (cmd === 'init') {
  const ns = init(repoRoot());
  console.log(`Created ${ns}\nNext: fill in MISSION.md, add a card (nightshift add "..."), then nightshift run.`);
} else if (cmd === 'add') {
  if (!rest[0]) die('Usage: nightshift add "title" [body]');
  const file = new Board(path.join(repoRoot(), '.nightshift', 'board')).add(rest[0], rest.slice(1).join(' '));
  console.log(`Added ${file}`);
} else if (cmd === 'status') {
  const b = new Board(path.join(repoRoot(), '.nightshift', 'board')).snapshot();
  for (const c of COLUMNS) console.log(`${c.padEnd(8)} ${b[c].length}${b[c].length ? '  ' + b[c].map((x) => x.title).join(' | ') : ''}`);
} else if (cmd === 'run') {
  const num = (v) => {
    if (v === undefined) return undefined;
    if (!Number.isFinite(Number(v)) || Number(v) < 0) die(`Expected a number, got "${v}".`);
    return Number(v);
  };
  const overrides = Object.fromEntries(
    Object.entries({
      forever: o.forever, maxTasks: num(o['max-tasks']), budgetUsd: num(o.budget), test: o.test,
      scout: o['no-scout'] ? { enabled: false } : undefined,
    }).filter(([, v]) => v !== undefined),
  );
  await run(repoRoot(), overrides, { mock: o.mock, dashboard: !o['no-dashboard'], port: Number(o.port ?? 4242), open: o.open });
} else if (cmd === 'demo') {
  await demo();
} else {
  die(`Unknown command "${cmd}".\n\n${HELP}`);
}
