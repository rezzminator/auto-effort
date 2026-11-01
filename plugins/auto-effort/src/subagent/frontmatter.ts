/**
 * Reads the scalar keys of a markdown file's leading YAML frontmatter
 * (`---` ... `---`): `key: value` lines at column 0, and one level of nesting
 * under a key with no value of its own, read as `parent.child`. A block list
 * (`- item` lines) under a key with no value reads as one comma list; block
 * scalars are skipped. No frontmatter → no fields; with no closing `---`, the
 * fields up to the end of the file, `unterminated` saying so.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; unterminated: boolean } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: {}, unterminated: false };
  const fields: Record<string, string> = {};
  let parent: string | undefined;
  // The last key read with no value of its own: the key a block list's items belong to.
  let list: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') return { fields, unterminated: false };
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (top) {
      const value = scalar(top[2] ?? '');
      fields[top[1] as string] = value;
      parent = value === '' ? (top[1] as string) : undefined;
      list = parent;
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      const value = scalar(item[1] ?? '');
      if (list !== undefined && value !== '') fields[list] = fields[list] ? `${fields[list]}, ${value}` : value;
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (nested && parent !== undefined) {
      const key = `${parent}.${nested[1]}`;
      fields[key] = scalar(nested[2] ?? '');
      list = fields[key] === '' ? key : undefined;
    }
  }
  return { fields, unterminated: true };
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '');
}
