import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Shift } from '../src/shift.js';
import { Board } from '../src/board.js';
import { handleLine } from '../src/agent.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.nightshift'));
  fs.writeFileSync(path.join(dir, '.nightshift', '.gitignore'), 'worktrees/\n');
  return dir;
}
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const shift = (dir, o = {}) => new Shift(dir, { mock: true, mockDelay: 0, scout: { enabled: false }, test: 'node -e "process.exit(0)"', ...o });

test('a night: ship, send back once, then ask a human', async () => {
  const dir = repo();
  const s = shift(dir);
  s.board.add('Add health endpoint', 'Done when: 200.');
  s.board.add('Paginate todos', '[mock:changes]');
  s.board.add('Pick storage', '[mock:question]');
  await s.run();

  const b = s.board.snapshot();
  assert.equal(b.done.length, 2);
  assert.equal(b.blocked.length, 1);
  assert.equal(s.stats.done, 2);

  const paginate = s.board.read('done', b.done.find((c) => c.title === 'Paginate todos').file);
  assert.match(paginate, /## Review \(round 1\): CHANGES/);
  assert.match(paginate, /## Review \(round 2\): APPROVE/);
  assert.match(s.board.read('blocked', b.blocked[0].file), /## Question\nShould this be on by default/);

  const log = git(dir, 'show', 'nightshift:WORKLOG.md');
  assert.match(log, /Add health endpoint/);
  assert.match(log, /Paginate todos/);
  assert.throws(() => git(dir, 'show', 'main:WORKLOG.md'), 'main stays untouched');

  const journal = fs.readFileSync(path.join(dir, '.nightshift', 'journal.md'), 'utf8');
  assert.equal(journal.match(/shipped:/g).length, 2);
  assert.match(journal, /blocked: Pick storage/);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.nightshift', 'worktrees')), []);
  assert.equal(git(dir, 'branch', '--list', 'ns/*'), '');

  // The answer puts the card back in line, and the next shift ships it.
  s.answer(b.blocked[0].file, 'Opt-in.');
  const s2 = shift(dir);
  await s2.run();
  assert.equal(s2.board.snapshot().done.length, 3);
});

test('failing tests send the card back, then block it with the output', async () => {
  const dir = repo();
  const s = shift(dir, { test: 'node -e "console.log(\'boom\'); process.exit(1)"', maxRounds: 2 });
  s.board.add('Break things', '');
  await s.run();
  const [card] = s.board.snapshot().blocked;
  const text = s.board.read('blocked', card.file);
  assert.equal(text.match(/## Tests failed/g).length, 2);
  assert.match(text, /boom/);
  assert.match(text, /Not approved after 2 rounds/);
});

test('scout fills an empty backlog', async () => {
  const dir = repo();
  const s = shift(dir, { scout: { enabled: true, batch: 2 }, maxTasks: 2 });
  await s.run();
  assert.equal(s.stats.tasks, 2);
});

test('budget stops the shift mid-card and puts the card back in line', async () => {
  const dir = repo();
  const s = shift(dir, { budgetUsd: 0.000001 });
  s.board.add('Expensive', '');
  await s.run();
  assert.equal(s.board.snapshot().todo.length, 1);
  assert.equal(s.stats.done, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.nightshift', 'run.lock')));
});

test('never moves the branch while it is checked out somewhere', async () => {
  const dir = repo();
  const s = shift(dir);
  s.setup();
  git(dir, 'worktree', 'add', '-q', path.join(dir, '..', path.basename(dir) + '-co'), 'nightshift');
  s.board.add('Ship it', '');
  await s.run();
  const [card] = s.board.snapshot().blocked;
  assert.match(s.board.read('blocked', card.file), /checked out somewhere/);
});

test('card names cannot escape the board', () => {
  const b = new Board(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-board-')));
  assert.throws(() => b.read('done', '../../etc/passwd.md'));
  assert.throws(() => b.read('nope', 'a.md'));
});

test('stream-json lines become feed events and a result', () => {
  const events = [];
  const acc = {};
  handleLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }), acc, (e) => events.push(e));
  handleLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.12 }), acc, () => {});
  handleLine('not json', acc, () => {});
  assert.deepEqual(events, [{ kind: 'text', text: 'hi' }, { kind: 'tool', name: 'Bash', detail: 'npm test' }]);
  assert.deepEqual(acc, { gotResult: true, text: 'done', costUsd: 0.12, isError: false });
});
