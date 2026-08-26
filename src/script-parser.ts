import type { ScriptItem } from './types';

export type ScriptParseMode = 'structured' | 'plain_text_compat';

export type ScriptParseSummary = {
  totalItems: number;
  emptyLabelCount: number;
  uniqueLabelCount: number;
  labelChangeCount: number;
};

export type ParseResult = {
  items: ScriptItem[];
  errors: string[];
  delimiter: ',' | '\t';
  mode: ScriptParseMode;
  warnings: string[];
  summary: ScriptParseSummary;
};

const headerAliases = {
  id: new Set(['id', '编号', '序号', '文本id', 'text_id', 'item_id']),
  text: new Set(['text', '文本', '内容', '正文', '文案', 'sentence', '句子', '句子正文', '唤醒词', 'wake', 'wakeword', 'wake_word']),
  label: new Set(['label', '标签', '要求', '备注', '备注标签', '语气', '强调', 'tag']),
};

const PLAIN_TEXT_WARNING = 'TXT 兼容导入：序号由系统生成，标签为空';

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

function recognizedHeaderCount(row: string[]): number {
  return [headerAliases.id, headerAliases.text, headerAliases.label]
    .filter((aliases) => findColumn(row, aliases) >= 0)
    .length;
}

function hasBalancedQuotes(line: string): boolean {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '"') continue;
    if (quoted && line[index + 1] === '"') {
      index += 1;
      continue;
    }
    quoted = !quoted;
  }
  return !quoted;
}

function summarize(items: readonly ScriptItem[]): ScriptParseSummary {
  const normalizedLabels = items.map((item) => item.label.trim());
  let labelChangeCount = 0;
  for (let index = 1; index < normalizedLabels.length; index += 1) {
    if (normalizedLabels[index - 1] !== normalizedLabels[index]) labelChangeCount += 1;
  }
  return {
    totalItems: items.length,
    emptyLabelCount: normalizedLabels.filter((label) => !label).length,
    uniqueLabelCount: new Set(normalizedLabels.filter(Boolean)).size,
    labelChangeCount,
  };
}

function result(
  items: ScriptItem[],
  errors: string[],
  delimiter: ',' | '\t',
  mode: ScriptParseMode,
  warnings: string[] = [],
): ParseResult {
  return { items, errors, delimiter, mode, warnings, summary: summarize(items) };
}

function parseDelimited(lines: string[], delimiter: ',' | '\t'): ParseResult {
  const errors: string[] = [];
  const first = parseRow(lines[0], delimiter);
  const idHeader = findColumn(first, headerAliases.id);
  const textHeader = findColumn(first, headerAliases.text);
  const labelHeader = findColumn(first, headerAliases.label);
  // Label/text values can legitimately equal aliases (for example a data row
  // `0001,正文,强调`). A conventional header is authoritative when its
  // first cell is a known ID heading; reordered headers are recognized only
  // when all three semantic headings are present. An incomplete two-column
  // header still enters header validation so the missing contract column is
  // reported instead of becoming a fake data row.
  const headerCount = recognizedHeaderCount(first);
  const hasHeader = idHeader === 0
    || headerCount === 3
    || (first.length < 3 && headerCount > 0);
  const idIndex = hasHeader ? idHeader : 0;
  const textIndex = hasHeader ? textHeader : 1;
  const labelIndex = hasHeader ? labelHeader : 2;
  if (hasHeader && first.length !== 3) errors.push(`第 1 行：必须正好包含“序号、正文、标签”三列，当前为 ${first.length} 列`);
  if (!hasBalancedQuotes(lines[0])) errors.push('第 1 行：CSV 引号未闭合');
  if (idIndex < 0) errors.push('未找到 id/编号 列');
  if (textIndex < 0) errors.push('未找到 text/文本 列');
  if (labelIndex < 0) errors.push('未找到 label/标签 列（第三列）');
  if (errors.length) return result([], errors, delimiter, 'structured');

  const items: ScriptItem[] = [];
  const seen = new Set<string>();
  const start = hasHeader ? 1 : 0;
  for (let index = start; index < lines.length; index += 1) {
    const row = parseRow(lines[index], delimiter);
    const id = row[idIndex]?.trim() ?? '';
    const text = row[textIndex]?.trim() ?? '';
    const labelCellExists = labelIndex < row.length;
    const label = labelCellExists ? row[labelIndex]?.trim() ?? '' : '';
    const lineNumber = index + 1;
    const hasExactlyThreeColumns = row.length === 3;
    const balancedQuotes = hasBalancedQuotes(lines[index]);
    if (!balancedQuotes) errors.push(`第 ${lineNumber} 行：CSV 引号未闭合`);
    if (!hasExactlyThreeColumns) errors.push(`第 ${lineNumber} 行：必须正好包含三列，正文中的分隔符请使用 CSV 引号包裹`);
    if (!id) errors.push(`第 ${lineNumber} 行：ID 为空`);
    if (!text) errors.push(`第 ${lineNumber} 行：文本为空`);
    if (!labelCellExists) errors.push(`第 ${lineNumber} 行：缺少标签列（第三列）`);
    if (id && seen.has(id)) errors.push(`第 ${lineNumber} 行：ID “${id}” 重复`);
    if (!id || !text || !labelCellExists || !hasExactlyThreeColumns || !balancedQuotes || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text, label });
  }
  if (!items.length && !errors.length) errors.push('脚本没有可用数据行');
  return result(items, errors, delimiter, 'structured');
}

function fileExtension(fileName?: string): string {
  const match = fileName?.trim().toLowerCase().match(/\.([^.\\/]+)$/);
  return match?.[1] ?? '';
}

function looksLikeHeaderlessCsv(rows: string[][]): boolean {
  if (!rows.length || !rows.every((row) => row.length >= 2)) return false;
  // Without a filename, two comma-separated fields are inherently ambiguous.
  // Treat comma-bearing content as a structured script only when column one
  // looks like the sequence identifier promised by the import contract;
  // ordinary prose such as "Hello, world, please read naturally" remains in
  // explicit plain-text compatibility mode even without a filename hint.
  return rows.every((row) => /\d/.test(row[0]) && !/\s/.test(row[0]));
}

function looksLikeStrictThreeColumnTable(rows: string[][]): boolean {
  if (!rows.length) return false;
  // An explicit complete header is authoritative. Keep the file in
  // structured mode so malformed data rows surface as import errors instead
  // of silently falling back to label-less plain text.
  if (recognizedHeaderCount(rows[0]) === 3) return true;
  if (!rows.every((row) => row.length === 3)) return false;
  const identifier = /^(?=.*\d)[a-z0-9_-]+$/i;
  return rows.every((row) => identifier.test(row[0]));
}

function structuredDelimiter(
  lines: string[],
  fileName?: string,
): ',' | '\t' | null {
  const extension = fileExtension(fileName);
  if (extension === 'csv') return ',';
  if (extension === 'tsv' || extension === 'tab') return '\t';
  // Historical collection scripts sometimes use a .txt suffix even though
  // every row is a strict three-column TSV record. Preserve that input while
  // keeping ordinary TXT (including prose that happens to contain tabs) in
  // the explicit line-oriented compatibility mode.
  if (extension === 'txt') {
    const tabRows = lines.map((line) => parseRow(line, '\t'));
    return looksLikeStrictThreeColumnTable(tabRows) ? '\t' : null;
  }
  if (lines.some((line) => line.includes('\t'))) return '\t';
  if (!lines.length) return null;
  const commaRows = lines.map((line) => parseRow(line, ','));
  if (recognizedHeaderCount(commaRows[0]) >= 2 || looksLikeHeaderlessCsv(commaRows)) return ',';
  return null;
}

export function parseScript(content: string, fileName?: string): ParseResult {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  const delimiter = structuredDelimiter(lines, fileName);
  if (!lines.length) {
    return result(
      [],
      ['脚本为空'],
      delimiter ?? ',',
      delimiter ? 'structured' : 'plain_text_compat',
      [],
    );
  }
  if (delimiter) return parseDelimited(lines, delimiter);

  const idWidth = Math.max(4, String(lines.length).length);
  return result(
    lines.map((line, index) => ({
      id: String(index + 1).padStart(idWidth, '0'),
      text: line.trim(),
      label: '',
    })),
    [],
    ',',
    'plain_text_compat',
    [PLAIN_TEXT_WARNING],
  );
}
