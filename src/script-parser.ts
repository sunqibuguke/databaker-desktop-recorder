import type { ScriptItem } from './types';

export type ParseResult = { items: ScriptItem[]; errors: string[]; delimiter: ',' | '\t' };

const headerAliases = {
  id: new Set(['id', '编号', '序号', '文本id', 'text_id', 'item_id']),
  text: new Set(['text', '文本', '内容', '正文', '文案', 'sentence', '句子', '句子正文']),
  label: new Set(['label', '标签', '要求', '备注', '语气', '强调', 'tag']),
};

function parseRow(line: string, delimiter: ',' | '\t'): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function findColumn(headers: string[], aliases: Set<string>): number {
  return headers.findIndex((header) => aliases.has(header.trim().toLowerCase()));
}

export function parseScript(content: string): ParseResult {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  const delimiter: ',' | '\t' = (lines[0]?.match(/\t/g)?.length ?? 0) > (lines[0]?.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const errors: string[] = [];
  if (!lines.length) return { items: [], errors: ['脚本为空'], delimiter };

  const isPlainText = !lines.some((line) => line.includes(',') || line.includes('\t'));
  if (isPlainText) {
    const idWidth = Math.max(4, String(lines.length).length);
    return {
      items: lines.map((line, index) => ({
        id: String(index + 1).padStart(idWidth, '0'),
        text: line.trim(),
        label: '',
      })),
      errors,
      delimiter,
    };
  }

  const first = parseRow(lines[0], delimiter);
  const idHeader = findColumn(first, headerAliases.id);
  const textHeader = findColumn(first, headerAliases.text);
  const hasHeader = idHeader >= 0 || textHeader >= 0;
  const idIndex = hasHeader ? idHeader : 0;
  const textIndex = hasHeader ? textHeader : 1;
  const labelIndex = hasHeader ? findColumn(first, headerAliases.label) : 2;
  if (idIndex < 0) errors.push('未找到 id/编号 列');
  if (textIndex < 0) errors.push('未找到 text/文本 列');
  if (errors.length) return { items: [], errors, delimiter };

  const items: ScriptItem[] = [];
  const seen = new Set<string>();
  const start = hasHeader ? 1 : 0;
  for (let index = start; index < lines.length; index += 1) {
    const row = parseRow(lines[index], delimiter);
    const id = row[idIndex]?.trim() ?? '';
    const text = row[textIndex]?.trim() ?? '';
    const label = labelIndex >= 0 ? row[labelIndex]?.trim() ?? '' : '';
    const lineNumber = index + 1;
    if (!id) errors.push(`第 ${lineNumber} 行：ID 为空`);
    if (!text) errors.push(`第 ${lineNumber} 行：文本为空`);
    if (seen.has(id)) errors.push(`第 ${lineNumber} 行：ID “${id}” 重复`);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text, label });
  }
  if (!items.length && !errors.length) errors.push('脚本没有可用数据行');
  return { items, errors, delimiter };
}
