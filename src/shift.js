// The shift: pick a card, build it in a worktree, test it, review it, merge it, remember it. Repeat.
import { EventEmitter } from 'node:events';
import { execFileSync, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Board, titleOf } from './board.js';
import { runAgent } from './agent.js';
import * as prompts from './prompts.js';

export const DEFAULTS = {
  base: null, // branch the night starts from; null = whatever is checked out
  branch: 'nightshift', // every approved card lands here, never on your main branch
  test: null, // e.g. "npm test"; runs after each build, before review
  maxTasks: 10,
  maxRounds: 3, // build -> test -> review attempts per card
  budgetUsd: 25, // stop the shift once agents report this much spend
  agentBudgetUsd: 5, // cap per agent run (claude --max-budget-usd)
  forever: false, // keep polling for new cards instead of stopping
  limitBackoffMin: 20, // wait this long when a usage limit hits, then retry
  scout: { enabled: true, batch: 3 },
  roles: {
    scout: { model: 'sonnet', permissionMode: 'dontAsk', allowedTools: ['Read', 'Glob', 'Grep'] },
    // Headless runs can't answer permission prompts: the builder may edit files in its worktree,
    // and run only your test command. Widen allowedTools in config.json if your project needs more.
    builder: { model: null, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite'] },
    reviewer: { model: 'sonnet', permissionMode: 'dontAsk', allowedTools: ['Read', 'Glob', 'Grep'] },
  },
};

export function loadConfig(nsDir, overrides = {}) {
  const file = path.join(nsDir, 'config.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = { ...DEFAULTS, ...user, ...overrides };
  cfg.scout = { ...DEFAULTS.scout, ...user.scout, ...overrides.scout };
  cfg.roles = Object.fromEntries(
    Object.keys(DEFAULTS.roles).map((r) => [r, { ...DEFAULTS.roles[r], ...user.roles?.[r], ...overrides.roles?.[r] }]),
  );
  return cfg;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tail = (s, n) => (s.length > n ? '…' + s.slice(-n) : s);

export class Shift extends EventEmitter {
  constructor(root, { mock = false, mockDelay, ...overrides } = {}) {
    super();
    this.root = root;
    this.ns = path.join(root, '.nightshift');
    this.cfg = loadConfig(this.ns, overrides);
    this.mock = mock;
    this.mockDelay = mockDelay;
    this.board = new Board(path.join(this.ns, 'board'));
    this.phase = 'idle';
    this.card = null;
    this.round = 0;
    this.stats = { done: 0, blocked: 0, tasks: 0, costUsd: 0, startedAt: Date.now() };
    this.feed = [];
    this.stopping = false;
    this.wake = () => {};
    this.wakeIdle = () => {};
    this.limitStreak = 0;
  }

  // --- what the dashboard sees ---

  state() {
    const { cfg } = this;
    return {
      phase: this.phase,
      card: this.card,
      round: this.round,
      stats: this.stats,
      board: this.board.snapshot(),
      journal: this.journalTail(4000),
      config: { branch: cfg.branch, maxTasks: cfg.maxTasks, maxRounds: cfg.maxRounds, budgetUsd: cfg.budgetUsd, test: cfg.test, mock: this.mock },
      stopping: this.stopping,
    };
  }

  log(kind, text) {
    const line = { t: Date.now(), phase: this.phase, kind, text: String(text).slice(0, 2000) };
    this.feed.push(line);
    if (this.feed.length > 400) this.feed.shift();
    this.emit('feed', line);
  }

  setPhase(phase, card = this.card) {
    this.phase = phase;
    this.card = card;
    this.emit('state');
  }

  // --- the loop ---

  setup() {
    git(this.root, 'rev-parse', 'HEAD'); // throws in an empty repo
    const current = git(this.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (current === this.cfg.branch) throw new Error(`Check out another branch first: nightshift moves "${this.cfg.branch}" itself.`);
    try {
      git(this.root, 'rev-parse', '--verify', `refs/heads/${this.cfg.branch}`);
    } catch {
      git(this.root, 'branch', this.cfg.branch, this.cfg.base || 'HEAD');
      this.log('info', `Created branch ${this.cfg.branch} from ${this.cfg.base || current}.`);
    }
    // A card left in doing/review means the last shift died mid-task. Put it back in line.
    for (const col of ['doing', 'review']) for (const f of this.board.list(col)) this.board.move(f, col, 'todo');
  }

  async run() {
    // One shift per repo: two would requeue each other's cards and race on the branch.
    const lock = path.join(this.ns, 'run.lock');
    try {
      process.kill(Number(fs.readFileSync(lock, 'utf8')), 0);
      throw new Error('Another nightshift is already running on this repo.');
    } catch (e) {
      if (e.message.startsWith('Another')) throw e;
    }
    fs.writeFileSync(lock, String(process.pid));
    try {
      await this.loop();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  async loop() {
    this.setup();
    this.log('info', `Shift started${this.mock ? ' (mock agents, no tokens spent)' : ''}.`);
    let emptyScouts = 0;
    while (!this.stopping) {
      if (this.stats.tasks >= this.cfg.maxTasks) { this.log('info', `Reached maxTasks (${this.cfg.maxTasks}).`); break; }
      if (this.overBudget()) break;

      const next = this.board.list('todo')[0];
      if (next) {
        emptyScouts = 0;
        await this.work(next);
      } else if (this.cfg.scout.enabled && emptyScouts < 2) {
        emptyScouts = (await this.scout()) ? 0 : emptyScouts + 1;
      } else if (this.cfg.forever) {
        this.setPhase('idle', null);
        await this.sleep(30_000, true);
        emptyScouts = 0;
      } else {
        this.log('info', 'Backlog is empty.');
        break;
      }
    }
    this.stats.endedAt = Date.now();
    this.setPhase('stopped', null);
    this.log('info', `Shift over: ${this.stats.done} shipped, ${this.stats.blocked} need you, $${this.stats.costUsd.toFixed(2)} spent.`);
  }

  stop() {
    this.stopping = true;
    this.wake();
    this.emit('state');
  }

  // stop() ends any sleep. New cards and answers end only the idle sleep, never a usage-limit backoff.
  sleep(ms, idle = false) {
    if (this.stopping) return Promise.resolve();
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      this.wake = () => { clearTimeout(t); r(); };
      this.wakeIdle = idle ? this.wake : () => {};
    });
  }

  overBudget() {
    if (this.stats.costUsd < this.cfg.budgetUsd) return false;
    if (!this.stopping) this.log('info', `Reached the $${this.cfg.budgetUsd} budget.`);
    this.stopping = true;
    return true;
  }

  async scout() {
    this.setPhase('scout', null);
    const wt = this.worktree('_scout', ['--detach'], this.cfg.branch);
    const res = await this.agent('scout', prompts.scout({ ...this.context(), batch: this.cfg.scout.batch }), wt);
    this.removeWorktree(wt);
    if (res.limitHit) return this.backoff();
    const json = res.text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? res.text.slice(res.text.indexOf('['), res.text.lastIndexOf(']') + 1);
    let ideas = [];
    try {
      ideas = JSON.parse(json);
    } catch {
      this.log('error', 'Scout reply had no JSON task list.');
    }
    if (!Array.isArray(ideas)) ideas = [];
    const added = ideas.filter((i) => typeof i?.title === 'string' && i.title.trim()).slice(0, this.cfg.scout.batch);
    for (const i of added) this.board.add(i.title, String(i.body ?? ''));
    this.log('info', `Scout added ${added.length} card${added.length === 1 ? '' : 's'}.`);
    this.emit('state');
    return added.length > 0;
  }

  async work(file) {
    this.board.move(file, 'todo', 'doing');
    const title = titleOf(this.board.read('doing', file)) || file;
    const slugName = file.replace(/\.md$/, '');
    const wt = path.join(this.ns, 'worktrees', slugName);
    this.stats.tasks++;
    this.setPhase('build', { file, title });
    this.log('info', `Picked up "${title}".`);
    try {
      await this.attempt(file, title, slugName, wt);
    } catch (e) {
      // A git hook, a locked file on Windows, anything unexpected: park the card, keep the shift alive.
      if (this.board.find(file)) this.block(file, title, `nightshift hit an error: ${e.message}`, wt);
    }
  }

  async attempt(file, title, slugName, wt) {
    const { cfg, board } = this;
    const branch = `ns/${slugName}`;
    // A blocked card keeps its last attempt; set it aside instead of overwriting it.
    try {
      git(this.root, 'rev-parse', '--verify', `refs/heads/${branch}`);
      git(this.root, 'branch', '-m', branch, `${branch}-attempt-${Date.now().toString(36)}`);
    } catch {}
    this.worktree(slugName, ['-b', branch], cfg.branch);
    const card = { file, title };

    for (this.round = 1; this.round <= cfg.maxRounds; this.round++) {
      if (this.stopping || this.overBudget()) break;
      const r = this.round;

      this.setPhase('build', card);
      const built = await this.agent('builder', prompts.builder({ ...this.context(), card: board.read(board.find(file), file), test: cfg.test }), wt);
      if (built.limitHit) {
        if (!(await this.backoff())) return this.block(file, title, `Kept hitting a limit or overload: ${tail(built.text, 500)}`, wt);
        this.round--;
        continue;
      }
      if (built.isError) return this.block(file, title, `Builder failed: ${tail(built.text, 1500)}`, wt);
      const question = built.text.match(/^QUESTION:\s*([\s\S]+)/m)?.[1];
      if (question) return this.block(file, title, `## Question\n${question.trim()}`, wt);
      const summary = built.text.match(/SUMMARY:\s*([\s\S]+)/)?.[1]?.trim() ?? tail(built.text, 600);
      board.append(board.find(file), file, `## Build (round ${r})\n${summary}`);

      git(wt, 'add', '-A');
      if (git(wt, 'status', '--porcelain')) git(wt, 'commit', '-q', '-m', `nightshift: ${title}${r > 1 ? ` (round ${r})` : ''}`);
      if (git(wt, 'rev-list', '--count', `${cfg.branch}..HEAD`) === '0') return this.block(file, title, 'Builder made no changes.', wt);

      let tests = '';
      if (cfg.test) {
        this.setPhase('test', card);
        const t = await this.runTests(wt);
        tests = `\`${cfg.test}\` ${t.ok ? 'passed' : 'FAILED'}\n${tail(t.out, 3000)}`;
        this.log(t.ok ? 'info' : 'error', `Tests ${t.ok ? 'passed' : 'failed'}.`);
        if (!t.ok) {
          board.append(board.find(file), file, `## Tests failed (round ${r})\n\`\`\`\n${tail(t.out, 3000)}\n\`\`\``);
          continue;
        }
      }

      if (this.stopping || this.overBudget()) break;
      board.move(file, board.find(file), 'review');
      this.setPhase('review', card);
      const diff = tail(git(wt, 'diff', `${cfg.branch}...HEAD`), 80_000);
      const review = await this.agent('reviewer', prompts.reviewer({ ...this.context(), card: board.read('review', file), tests, diff }), wt);
      if (review.limitHit) {
        board.move(file, 'review', 'doing');
        if (!(await this.backoff())) return this.block(file, title, `Kept hitting a limit or overload: ${tail(review.text, 500)}`, wt);
        this.round--;
        continue;
      }
      const verdict = [...review.text.matchAll(/VERDICT:\s*(APPROVE|CHANGES)/gi)].pop()?.[1].toUpperCase() ?? 'CHANGES';
      board.append('review', file, `## Review (round ${r}): ${verdict}\n${review.text.replace(/VERDICT:\s*\w+/gi, '').trim()}`);
      this.log(verdict === 'APPROVE' ? 'info' : 'error', `Reviewer: ${verdict}.`);

      if (verdict === 'APPROVE') {
        this.setPhase('merge', card);
        return this.merge(file, title, branch, summary, wt);
      }
      board.move(file, 'review', 'doing');
    }
    if (this.stopping) {
      board.move(file, board.find(file), 'todo');
      this.removeWorktree(wt);
      return;
    }
    return this.block(file, title, `Not approved after ${cfg.maxRounds} rounds. The branch \`${branch}\` has the last attempt.`, wt);
  }

  merge(file, title, branch, summary, wt) {
    const { cfg } = this;
    // Cards run one at a time from the branch tip, so landing one is a fast-forward.
    try {
      git(this.root, 'merge-base', '--is-ancestor', cfg.branch, branch);
    } catch {
      return this.block(file, title, `${cfg.branch} moved under this card; merge \`${branch}\` by hand.`, wt);
    }
    // Moving a branch that is checked out somewhere would leave that checkout showing the work reverted.
    if (git(this.root, 'worktree', 'list', '--porcelain').split('\n').includes(`branch refs/heads/${cfg.branch}`)) {
      return this.block(file, title, `${cfg.branch} is checked out somewhere, so nightshift won't move it. Merge \`${branch}\` by hand.`, wt);
    }
    const old = git(this.root, 'rev-parse', cfg.branch);
    git(this.root, 'update-ref', `refs/heads/${cfg.branch}`, git(this.root, 'rev-parse', branch), old);
    this.board.move(file, this.board.find(file), 'done');
    this.removeWorktree(wt);
    git(this.root, 'branch', '-D', branch);
    this.stats.done++;
    this.journal(`shipped: ${title}`, summary);
    this.log('info', `Shipped "${title}" to ${cfg.branch}.`);
    this.setPhase('idle', null);
  }

  block(file, title, why, wt) {
    this.board.append(this.board.find(file), file, why.startsWith('## ') ? why : `## Blocked\n${why}`);
    this.board.move(file, this.board.find(file), 'blocked');
    if (wt) this.removeWorktree(wt);
    // Keep the branch only if it holds an attempt worth looking at.
    const branch = `ns/${file.replace(/\.md$/, '')}`;
    try { if (git(this.root, 'rev-list', '--count', `${this.cfg.branch}..${branch}`) === '0') git(this.root, 'branch', '-D', branch); } catch {}
    this.stats.blocked++;
    this.journal(`blocked: ${title}`, why.replace(/^## \w+\n/, ''));
    this.log('error', `"${title}" needs you: ${why.replace(/^## \w+\n/, '').slice(0, 200)}`);
    this.setPhase('idle', null);
  }

  answer(file, text) {
    if (this.board.find(file) !== 'blocked') throw new Error('That card is not waiting on you.');
    this.board.append('blocked', file, `## Answer\n${text}`);
    this.board.move(file, 'blocked', 'todo');
    this.log('info', `Answer received; "${file}" is back in line${this.phase === 'stopped' ? ' for the next shift' : ''}.`);
    this.wakeIdle();
    this.emit('state');
  }

  addCard(title, body) {
    const file = this.board.add(title, body);
    this.log('info', `New card: "${title}"${this.phase === 'stopped' ? ' (runs next shift)' : ''}.`);
    this.wakeIdle();
    this.emit('state');
    return file;
  }

  // --- helpers ---

  async agent(role, prompt, cwd) {
    const r = { ...this.cfg.roles[role] };
    if (role === 'builder' && this.cfg.test && r.allowedTools) r.allowedTools = [...r.allowedTools, `Bash(${this.cfg.test})`];
    const res = await runAgent({
      role, prompt, cwd, ...r,
      budgetUsd: this.cfg.agentBudgetUsd, mock: this.mock, mockDelay: this.mockDelay,
      onEvent: (ev) => this.log(ev.kind, ev.kind === 'tool' ? `${ev.name} ${ev.detail}` : ev.text),
    });
    this.stats.costUsd += res.costUsd;
    if (!res.limitHit) this.limitStreak = 0;
    if (res.isError) this.log('error', `${role} error: ${res.text.slice(0, 300)}`);
    this.emit('state');
    return res;
  }

  // Returns false after several limits in a row, so a permanent error can't loop all night.
  async backoff() {
    if (++this.limitStreak > 4) return false;
    this.setPhase('paused');
    this.log('info', `Usage limit hit. Sleeping ${this.cfg.limitBackoffMin} min, then picking up where it left off.`);
    await this.sleep(this.cfg.limitBackoffMin * 60_000);
    return true;
  }

  runTests(cwd) {
    return new Promise((resolve) =>
      exec(this.cfg.test, { cwd, timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({ ok: !err, out: `${stdout}${stderr}` }),
      ),
    );
  }

  worktree(name, flags, ref) {
    const wt = path.join(this.ns, 'worktrees', name);
    this.removeWorktree(wt);
    git(this.root, 'worktree', 'add', '-q', ...flags, wt, ref);
    return wt;
  }

  removeWorktree(wt) {
    try { git(this.root, 'worktree', 'remove', '--force', wt); } catch {}
    fs.rmSync(wt, { recursive: true, force: true });
    try { git(this.root, 'worktree', 'prune'); } catch {}
  }

  context() {
    const mission = path.join(this.ns, 'MISSION.md');
    return { mission: fs.existsSync(mission) ? fs.readFileSync(mission, 'utf8') : '', journal: this.journalTail(6000) };
  }

  journalTail(n) {
    const file = path.join(this.ns, 'journal.md');
    if (!fs.existsSync(file)) return '';
    const s = fs.readFileSync(file, 'utf8');
    if (s.length <= n) return s;
    const cut = s.slice(-n);
    return cut.slice(Math.max(0, cut.indexOf('\n### ')));
  }

  journal(heading, body) {
    const d = new Date();
    const stamp = `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 5)}`;
    fs.appendFileSync(path.join(this.ns, 'journal.md'), `\n### ${stamp} ${heading}\n${body.trim()}\n`);
  }
}
