'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const { parseScript } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'script-parser.ts')).href);

  const csv = parseScript('id,text,label\n0001,今天天气很好，适合出去散步。,正常语速\n0002,请保持自然、清晰的发音。,无杂音', 'script.csv');
  assert.equal(csv.delimiter, ',');
  assert.equal(csv.mode, 'structured');
  assert.deepEqual(csv.warnings, []);
  assert.deepEqual(csv.errors, []);
  assert.equal(csv.items.length, 2);
  assert.equal(csv.items[0].id, '0001');
  assert.equal(csv.items[0].text, '今天天气很好，适合出去散步。');
  assert.equal(csv.items[0].label, '正常语速');
  assert.deepEqual(csv.summary, {
    totalItems: 2,
    emptyLabelCount: 0,
    uniqueLabelCount: 2,
    labelChangeCount: 1,
  });

  const headerlessCsv = parseScript('0001,第一句,自然\n0002,第二句,强调', 'headerless.csv');
  assert.deepEqual(headerlessCsv.errors, []);
  assert.deepEqual(headerlessCsv.items[1], { id: '0002', text: '第二句', label: '强调' });

  const headerAliasAsFirstLabel = parseScript('0001,第一句,强调\n0002,第二句,自然', 'header-alias-label.csv');
  assert.deepEqual(headerAliasAsFirstLabel.errors, []);
  assert.deepEqual(
    headerAliasAsFirstLabel.items[0],
    { id: '0001', text: '第一句', label: '强调' },
    '首行标签恰好命中表头别名时仍必须按无表头三列数据解析',
  );

  const aliasesAsFirstData = parseScript('0001,正文,强调\n0002,普通句,自然', 'aliases-as-data.csv');
  assert.deepEqual(aliasesAsFirstData.errors, []);
  assert.deepEqual(aliasesAsFirstData.items[0], { id: '0001', text: '正文', label: '强调' });

  const unsupportedHeaderNames = parseScript('id,copy,category\n0001,第一句,自然', 'bad-header.csv');
  assert.deepEqual(unsupportedHeaderNames.items, []);
  assert.ok(unsupportedHeaderNames.errors.some((error) => error.includes('text/文本')));
  assert.ok(unsupportedHeaderNames.errors.some((error) => error.includes('label/标签')));

  const tsv = parseScript('id\ttext\tlabel\n0001\t今天天气很好，适合出去散步。\t正常语速\n0002\t请保持自然、清晰的发音。\t无杂音');
  assert.equal(tsv.delimiter, '\t');
  assert.equal(tsv.mode, 'structured');
  assert.deepEqual(tsv.errors, []);
  assert.equal(tsv.items.length, 2);
  assert.equal(tsv.items[1].text, '请保持自然、清晰的发音。');

  const wakeWordHeaders = parseScript('编号\t唤醒词\t备注标签\n0001\they Jack\t正常\n0002\thi Eva\t清晰');
  assert.equal(wakeWordHeaders.delimiter, '\t');
  assert.deepEqual(wakeWordHeaders.errors, []);
  assert.deepEqual(wakeWordHeaders.items[0], { id: '0001', text: 'hey Jack', label: '正常' });
  assert.equal(wakeWordHeaders.items[1].text, 'hi Eva');

  const headerlessTsv = parseScript('0001\t请读这一句\t慢语速\n0002\t再读一句\t正常');
  assert.equal(headerlessTsv.delimiter, '\t');
  assert.deepEqual(headerlessTsv.errors, []);
  assert.deepEqual(headerlessTsv.items[0], { id: '0001', text: '请读这一句', label: '慢语速' });

  const tsvWithAsciiCommas = parseScript('0001\tHello, world, please read slowly.\tcalm\n0002\tYes, continue, then stop.\tnormal');
  assert.equal(tsvWithAsciiCommas.delimiter, '\t', 'comma-heavy TSV body must fall back to tab split');
  assert.deepEqual(tsvWithAsciiCommas.errors, []);
  assert.equal(tsvWithAsciiCommas.items[0].id, '0001');
  assert.equal(tsvWithAsciiCommas.items[0].text, 'Hello, world, please read slowly.');
  assert.equal(tsvWithAsciiCommas.items[0].label, 'calm');
  assert.equal(tsvWithAsciiCommas.items[1].text, 'Yes, continue, then stop.');

  const commaHeaderTabBody = parseScript('id,text\n0001\t第一句还带逗号, 以及停顿\n0002\t第二句');
  assert.equal(commaHeaderTabBody.delimiter, '\t');
  assert.equal(commaHeaderTabBody.mode, 'structured');
  assert.equal(commaHeaderTabBody.items.length, 0);
  assert.ok(commaHeaderTabBody.errors.some((error) => error.includes('三列')));

  const quotedCsv = parseScript('id,text,label\n0001,"Hello, world",calm');
  assert.equal(quotedCsv.delimiter, ',');
  assert.deepEqual(quotedCsv.errors, []);
  assert.equal(quotedCsv.items[0].text, 'Hello, world');

  const malformedQuotedCsv = parseScript('id,text,label\n0001,"Hello, world,calm', 'malformed.csv');
  assert.deepEqual(malformedQuotedCsv.items, []);
  assert.ok(malformedQuotedCsv.errors.some((error) => error.includes('引号未闭合')));

  const unquotedExtraColumn = parseScript('id,text,label\n0001,Hello, world,calm', 'extra-column.csv');
  assert.deepEqual(unquotedExtraColumn.items, []);
  assert.ok(
    unquotedExtraColumn.errors.some((error) => error.includes('正好包含三列')),
    '未加引号的正文逗号不得静默错位并丢弃第四列',
  );

  const csvKeepsRowError = parseScript('id,text,label\n0001,第一句,正常\n0002,,正常\n0003,第三句,');
  assert.equal(csvKeepsRowError.delimiter, ',');
  assert.equal(csvKeepsRowError.items.length, 2);
  assert.equal(csvKeepsRowError.items[0].text, '第一句');
  assert.equal(csvKeepsRowError.items[1].id, '0003');
  assert.equal(csvKeepsRowError.items[1].label, '', '第三格存在时允许单行标签为空');
  assert.ok(csvKeepsRowError.errors.some((error) => error.includes('第 3 行')));

  const duplicateIds = parseScript('id,text,label\n0001,第一句,A\n0001,第二句,B', 'duplicates.csv');
  assert.equal(duplicateIds.items.length, 1);
  assert.ok(duplicateIds.errors.some((error) => error.includes('重复')));

  const missingLabelHeader = parseScript('id,text\n0001,第一句\n0002,第二句', 'missing-label.csv');
  assert.equal(missingLabelHeader.mode, 'structured');
  assert.deepEqual(missingLabelHeader.items, []);
  assert.ok(missingLabelHeader.errors.some((error) => error.includes('label/标签')));

  const missingLabelCells = parseScript('0001\t第一句\n0002\t第二句', 'missing-label.tsv');
  assert.equal(missingLabelCells.mode, 'structured');
  assert.deepEqual(missingLabelCells.items, []);
  assert.equal(missingLabelCells.errors.filter((error) => error.includes('缺少标签列')).length, 2);

  const emptyLabels = parseScript('0001\t第一句\tA\n0002\t第二句\t\n0003\t第三句\tB\n0004\t第四句\tB\n0005\t第五句\t', 'labels.tsv');
  assert.deepEqual(emptyLabels.errors, []);
  assert.deepEqual(emptyLabels.summary, {
    totalItems: 5,
    emptyLabelCount: 2,
    uniqueLabelCount: 2,
    labelChangeCount: 3,
  });

  const reorderedChineseHeaders = parseScript('标签,序号,正文\n疑问,0001,这是问句吗', 'reordered.csv');
  assert.deepEqual(reorderedChineseHeaders.errors, []);
  assert.deepEqual(reorderedChineseHeaders.items[0], { id: '0001', text: '这是问句吗', label: '疑问' });

  const plain = parseScript('今天天气很好\nHello, world, please read naturally.\n请保持自然、清晰的发音。', 'collector-notes.txt');
  assert.equal(plain.mode, 'plain_text_compat');
  assert.equal(plain.delimiter, ',');
  assert.equal(plain.warnings.length, 1);
  assert.match(plain.warnings[0], /TXT 兼容导入/);
  assert.deepEqual(plain.errors, []);
  assert.equal(plain.items.length, 3);
  assert.equal(plain.items[0].id, '0001');
  assert.equal(plain.items[0].text, '今天天气很好');
  assert.equal(plain.items[1].text, 'Hello, world, please read naturally.');
  assert.deepEqual(plain.summary, {
    totalItems: 3,
    emptyLabelCount: 3,
    uniqueLabelCount: 0,
    labelChangeCount: 0,
  });

  const proseWithCommasWithoutName = parseScript('Hello, world, please read naturally.\nGoodbye, world, and pause.');
  assert.equal(
    proseWithCommasWithoutName.mode,
    'plain_text_compat',
    '普通正文中的逗号不能单独触发 CSV 识别',
  );
  assert.equal(proseWithCommasWithoutName.items[0].text, 'Hello, world, please read naturally.');

  const tabularTxt = parseScript('0001\t第一句\t正常\n0002\t第二句\t', 'script.txt');
  assert.equal(tabularTxt.mode, 'structured', '严格三列 Tab 的历史 TXT 应兼容为结构化脚本');
  assert.equal(tabularTxt.delimiter, '\t');
  assert.deepEqual(tabularTxt.errors, []);
  assert.deepEqual(tabularTxt.warnings, []);
  assert.deepEqual(tabularTxt.items[0], { id: '0001', text: '第一句', label: '正常' });
  assert.deepEqual(tabularTxt.items[1], { id: '0002', text: '第二句', label: '' });

  const headeredTabularTxt = parseScript('序号\t正文\t标签\n0001\t第一句\t自然', 'legacy.txt');
  assert.equal(headeredTabularTxt.mode, 'structured');
  assert.deepEqual(headeredTabularTxt.errors, []);
  assert.deepEqual(headeredTabularTxt.items[0], { id: '0001', text: '第一句', label: '自然' });

  const malformedHeaderedTxt = parseScript(
    '序号\t正文\t标签\n0001\t第一句\t自然\t多余',
    'malformed-legacy.txt',
  );
  assert.equal(malformedHeaderedTxt.mode, 'structured');
  assert.match(malformedHeaderedTxt.errors.join('\n'), /第 2 行：必须正好包含三列/);
  assert.equal(malformedHeaderedTxt.items.length, 0);

  const proseTxtWithTabs = parseScript('开场\t请自然朗读\t不要拆列\n结束语\t保持完整\t谢谢', 'notes.txt');
  assert.equal(proseTxtWithTabs.mode, 'plain_text_compat', '首列不像序号的三段 TXT 仍按每行正文解析');
  assert.equal(proseTxtWithTabs.items[0].text, '开场\t请自然朗读\t不要拆列');
  assert.equal(proseTxtWithTabs.items[0].label, '');

  const twoColumnTxt = parseScript('0001\t第一句\n0002\t第二句', 'two-column.txt');
  assert.equal(twoColumnTxt.mode, 'plain_text_compat', '两列 TXT 不应误进入三列结构化解析');
  assert.equal(twoColumnTxt.items[0].text, '0001\t第一句');

  const mixedWidthTxt = parseScript('0001\t第一句\t自然\n0002\t第二句\t正常\t额外', 'mixed-width.txt');
  assert.equal(mixedWidthTxt.mode, 'plain_text_compat', '混入非三列行时整份 TXT 应保守回退');
  assert.equal(mixedWidthTxt.items[1].text, '0002\t第二句\t正常\t额外');

  const proseIdTxt = parseScript('第1段\t开场正文\t自然\n第2段\t结束正文\t强调', 'prose-id.txt');
  assert.equal(proseIdTxt.mode, 'plain_text_compat', '普通中文段落编号不应被误认为结构化序号');

  const alphanumericIdTxt = parseScript('SENT-001\t第一句\t自然\nSENT-002\t第二句\t强调', 'legacy-ids.txt');
  assert.equal(alphanumericIdTxt.mode, 'structured', '历史字母数字序号仍应兼容三列 TXT');
  assert.equal(alphanumericIdTxt.items[1].id, 'SENT-002');

  const empty = parseScript('  \n\n');
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.errors, ['脚本为空']);
  assert.equal(empty.mode, 'plain_text_compat');
  assert.deepEqual(empty.warnings, []);
  assert.deepEqual(empty.summary, {
    totalItems: 0,
    emptyLabelCount: 0,
    uniqueLabelCount: 0,
    labelChangeCount: 0,
  });

  const emptyCsv = parseScript('', 'empty.csv');
  assert.equal(emptyCsv.mode, 'structured');
  assert.deepEqual(emptyCsv.warnings, []);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
