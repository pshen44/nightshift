// The backlog is a folder of markdown files. The folder a card sits in is its status.
import fs from 'node:fs';
import path from 'node:path';

export const COLUMNS = ['todo', 'doing', 'review', 'blocked', 'done'];

export class Board {
  constructor(dir) {
    this.dir = dir;
    for (const c of COLUMNS) fs.mkdirSync(path.join(dir, c), { recursive: true });
  }

  list(col) {
    return fs.readdirSync(path.join(this.dir, col)).filter((f) => f.endsWith('.md')).sort();
  }

  path(col, file) {
    // Card names come from the dashboard too, so never let one escape its column.
    if (!COLUMNS.includes(col) || file !== path.basename(file) || !file.endsWith('.md')) {
      throw new Error(`bad card: ${col}/${file}`);
    }
    return path.join(this.dir, col, file);
  }

  read(col, file) {
    return fs.readFileSync(this.path(col, file), 'utf8');
  }

  append(col, file, text) {
    fs.appendFileSync(this.path(col, file), `\n${text.trim()}\n`);
  }

  move(file, from, to) {
    fs.renameSync(this.path(from, file), this.path(to, file));
  }

  find(file) {
    return COLUMNS.find((c) => fs.existsSync(this.path(c, file)));
  }

  add(title, body = '', col = 'todo') {
    const file = `${Date.now().toString(36)}-${slug(title)}.md`;
    fs.writeFileSync(this.path(col, file), `# ${title.trim()}\n\n${body.trim()}\n`);
    return file;
  }

  snapshot() {
    return Object.fromEntries(
      COLUMNS.map((c) => [c, this.list(c).map((file) => ({ file, title: titleOf(this.read(c, file)) || file }))]),
    );
  }
}

export function titleOf(md) {
  return md.match(/^#\s+(.+)$/m)?.[1].trim() ?? '';
}

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}
