/**
 * Pull file references out of an answer.
 *
 * Nothing is uploaded: the bot only lists what DSH produced, so a chat platform
 * with no file support still tells the user where the artefact is.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_ATTACHMENTS = 10;
const TRAILING = /[.,;:!?)\]}>"'，。；：！？、）】》]+$/u;

export function collectAttachments(text) {
  const source = String(text ?? '');
  if (source === '') return [];
  const found = new Map();

  const add = (raw) => {
    const candidate = cleanTarget(raw);
    if (candidate === '') return;
    let info;
    try {
      info = statSync(candidate);
    } catch {
      return;
    }
    if (!info.isFile()) return;
    if (!found.has(candidate)) found.set(candidate, basename(candidate));
  };

  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(match[1]);
  for (const match of source.matchAll(/file:\/\/\/?([^\s)"'<>]+)/g)) {
    try {
      add(decodeURIComponent(match[1]));
    } catch {
      add(match[1]);
    }
  }
  for (const match of source.matchAll(/(?:[A-Za-z]:[\\/][^\s"'<>|*?]+|\/[\w.\-\u4e00-\u9fff]+\/[^\s"'<>|*?]+)/g)) {
    add(match[0]);
  }

  return [...found.entries()]
    .slice(0, MAX_ATTACHMENTS)
    .map(([path, name], index) => ({ index: index + 1, path, name }));
}

/** Render the "附件N：路径" block the bot appends to an answer. */
export function renderAttachments(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.map((entry) => `附件${entry.index}：${entry.path}`).join('\n');
}

function cleanTarget(raw) {
  let value = String(raw ?? '').trim();
  if (value === '') return '';
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/\/\/?/i, ''));
    } catch {
      value = value.replace(/^file:\/\/\/?/i, '');
    }
  }
  value = value.replace(TRAILING, '');
  if (value.startsWith('(') || value.startsWith('<')) value = value.slice(1);
  if (value === '' || value.includes('\n')) return '';
  return value;
}
