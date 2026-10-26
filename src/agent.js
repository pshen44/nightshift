// One agent run = one headless `claude -p` process. We read its stream-json output
// so the dashboard can show every tool call live.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LIMIT_RE = /usage limit|rate.?limit|limit (?:reached|exceeded)|overloaded|\b429\b/i;

export function runAgent(opts) {
  return opts.mock ? mockAgent(opts) : claudeAgent(opts);
}

const WIN = process.platform === 'win32';

// Agents die with nightshift, so a quit never leaves one writing into a worktree.
const running = new Set();
const killTree = (c) => (WIN ? spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) : c.kill('SIGTERM'));
process.on('exit', () => running.forEach(killTree));

function claudeAgent({ prompt, cwd, model, permissionMode = 'acceptEdits', allowedTools, budgetUsd, timeoutMin = 45, onEvent = () => {} }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', permissionMode];
  if (model) args.push('--model', model);
  if (budgetUsd) args.push('--max-budget-usd', String(budgetUsd));
  if (allowedTools) args.push(`--allowedTools=${allowedTools.join(',')}`);

  return new Promise((resolve) => {
    // The prompt goes over stdin. On Windows `claude` may be a .cmd shim, so it runs through the shell
    // and any arg with spaces, brackets or quotes (like "Bash(npm test)") gets quoted.
    const quoted = WIN ? args.map((a) => (/[\s()&|<>^"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)) : args;
    const child = spawn('claude', quoted, { cwd, shell: WIN, stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child);
    const timer = setTimeout(() => {
      stderr += `\nnightshift stopped this agent after ${timeoutMin} minutes.`;
      killTree(child);
    }, timeoutMin * 60_000);
    const acc = { text: '', costUsd: 0, isError: false, gotResult: false };
    // Show paths relative to the worktree; absolute ones drown the feed.
    const rel = (d) => (d === cwd ? '.' : d.split(cwd + path.sep).join('').split(cwd.replaceAll('\\', '/') + '/').join('')).slice(0, 140);
    const emit = (ev) => onEvent(ev.detail === undefined ? ev : { ...ev, detail: rel(ev.detail) });
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i), acc, emit);
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => (stderr += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);
      handleLine(buf, acc, emit);
      if (!acc.gotResult) {
        acc.isError = true;
        acc.text = acc.text || stderr.trim() || `claude exited with code ${code}`;
      }
      acc.limitHit = acc.isError && LIMIT_RE.test(acc.text + stderr);
      resolve(acc);
    });
    child.stdin.on('error', () => {}); // claude may exit before reading a long prompt
    child.stdin.end(prompt);
  });
}

export function handleLine(line, acc, onEvent) {
  if (!line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === 'assistant') {
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'text' && c.text.trim()) onEvent({ kind: 'text', text: c.text.trim() });
      if (c.type === 'tool_use') onEvent({ kind: 'tool', name: c.name, detail: toolDetail(c.input) });
    }
  } else if (ev.type === 'result') {
    acc.gotResult = true;
    acc.text = ev.result ?? (ev.errors ?? []).join('\n') ?? '';
    acc.costUsd = ev.total_cost_usd ?? 0;
    acc.isError = Boolean(ev.is_error) || ev.subtype !== 'success';
  }
}

function toolDetail(input = {}) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? '';
  return String(v).replace(/\s+/g, ' ');
}

// --- mock agent: no tokens spent. Powers `nightshift demo` and the tests. ---
// Cards steer it with markers: [mock:question] asks a human, [mock:changes] fails review once.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockAgent({ role, prompt, cwd, onEvent = () => {}, mockDelay = 600 }) {
  const say = async (ev) => {
    await sleep(mockDelay * (0.5 + Math.random()));
    onEvent(ev);
  };
  const title = prompt.match(/<card[^>]*>\s*#\s+(.+)/)?.[1] ?? 'task';
  const done = (text) => ({ text, costUsd: 0.01 + Math.random() * 0.05, isError: false, limitHit: false });

  if (role === 'scout') {
    await say({ kind: 'tool', name: 'Glob', detail: '**/*' });
    await say({ kind: 'tool', name: 'Read', detail: '.nightshift/MISSION.md' });
    await say({ kind: 'text', text: 'Reading the mission and the journal to pick what moves the project forward most.' });
    const pool = [
      'Validate todo titles on create', 'Return 404 instead of 500 for unknown ids', 'Add an ETag to GET /todos',
      'Log request timing', 'Cover the empty-list path with a test', 'Document the env vars in the README',
      'Graceful shutdown on SIGTERM', 'Reject bodies over 64 KB', 'Add due dates to todos', 'Sort todos by due date',
    ];
    const ideas = pool.sort(() => Math.random() - 0.5).slice(0, 2).map((title, i) => ({
      title, body: `Found while reading the handlers.\n\nDone when: covered by a test.${i ? ' [mock:changes]' : ''}`,
    }));
    return done('```json\n' + JSON.stringify(ideas, null, 2) + '\n```');
  }

  if (role === 'builder') {
    await say({ kind: 'tool', name: 'Read', detail: 'README.md' });
    await say({ kind: 'text', text: `Planning "${title}".` });
    if (prompt.includes('[mock:question]') && !prompt.includes('## Answer')) {
      return done('QUESTION: Should this be on by default, or opt-in behind a flag?');
    }
    await say({ kind: 'tool', name: 'Edit', detail: 'src/index.js' });
    fs.appendFileSync(path.join(cwd, 'WORKLOG.md'), `- ${title}\n`);
    await say({ kind: 'tool', name: 'Bash', detail: 'npm test' });
    return done(`Implemented "${title}" and ran the tests.\n\nSUMMARY: ${title} is in. Kept the change small and covered by a test.`);
  }

  // reviewer
  await say({ kind: 'tool', name: 'Read', detail: 'git diff' });
  await say({ kind: 'text', text: 'Checking the diff against the acceptance criteria.' });
  const firstRound = !prompt.includes('## Review');
  if (prompt.includes('[mock:changes]') && firstRound) {
    return done('The happy path works, but the error branch has no test.\n\nVERDICT: CHANGES\n- Add a test for the error branch.');
  }
  return done('Diff is small, matches the card, tests pass.\n\nVERDICT: APPROVE');
}
