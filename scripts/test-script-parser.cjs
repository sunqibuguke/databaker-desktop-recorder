'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const { parseScript } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'script-parser.ts')).href);

  const csv = parseScript('id,text,label\n0001,今天天气很好，适合出去散步。,正常语速\n0002,请保持自然、清晰的发音。,无杂音');
  assert.equal(csv.delimiter, ',');
  assert.deepEqual(csv.errors, []);
  assert.equal(csv.items.length, 2);
  assert.equal(csv.items[0].id, '0001');
  assert.equal(csv.items[0].text, '今天天气很好，适合出去散步。');
  assert.equal(csv.items[0].label, '正常语速');

  const tsv = parseScript('id\ttext\tlabel\n0001\t今天天气很好，适合出去散步。\t正常语速\n0002\t请保持自然、清晰的发音。\t无杂音');
  assert.equal(tsv.delimiter, '\t');
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
  assert.equal(commaHeaderTabBody.items.length, 2);
  assert.equal(commaHeaderTabBody.items[0].id, '0001');
  assert.equal(commaHeaderTabBody.items[0].text, '第一句还带逗号, 以及停顿');
  assert.equal(commaHeaderTabBody.items[1].text, '第二句');

  const quotedCsv = parseScript('id,text,label\n0001,"Hello, world",calm');
  assert.equal(quotedCsv.delimiter, ',');
  assert.deepEqual(quotedCsv.errors, []);
  assert.equal(quotedCsv.items[0].text, 'Hello, world');

  const csvKeepsRowError = parseScript('id,text\n0001,第一句\n0002,\n0003,第三句');
  assert.equal(csvKeepsRowError.delimiter, ',');
  assert.equal(csvKeepsRowError.items.length, 2);
  assert.equal(csvKeepsRowError.items[0].text, '第一句');
  assert.equal(csvKeepsRowError.items[1].id, '0003');
  assert.ok(csvKeepsRowError.errors.some((error) => error.includes('第 3 行')));

  const plain = parseScript('今天天气很好\n请保持自然、清晰的发音。');
  assert.equal(plain.items.length, 2);
  assert.equal(plain.items[0].id, '0001');
  assert.equal(plain.items[0].text, '今天天气很好');
  assert.equal(plain.items[1].id, '0002');

  const empty = parseScript('  \n\n');
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.errors, ['脚本为空']);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
