'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'electron', 'export-deliver.ts');
  const {
    deliveredExportFilePath,
    EXPORT_DELIVER_ERROR,
    exportPathsAreSameDirectory,
    isAllowedExportArtifactName,
  } = await import(pathToFileURL(modulePath).href);
  const i18nPath = path.join(__dirname, '..', 'src', 'export-deliver-i18n.ts');
  const { translateExportDeliverError } = await import(pathToFileURL(i18nPath).href);
  const { setLocale } = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'i18n', 'index.ts')).href);

  assert.equal(isAllowedExportArtifactName('full-track.wav'), true);
  assert.equal(isAllowedExportArtifactName('/tmp/export/cuts.zip'), true);
  assert.equal(isAllowedExportArtifactName('timestamps.json'), true);
  assert.equal(isAllowedExportArtifactName('session.json'), false);
  assert.equal(isAllowedExportArtifactName('full-track.wav.bak'), false);

  assert.equal(
    deliveredExportFilePath('/tmp/delivery', '/sessions/task/export/full-track.wav'),
    path.join(path.resolve('/tmp/delivery'), 'full-track.wav'),
  );
  assert.equal(
    exportPathsAreSameDirectory('/tmp/delivery/', '/tmp/delivery'),
    true,
  );
  assert.equal(
    exportPathsAreSameDirectory('/tmp/delivery', '/tmp/other'),
    false,
  );

  assert.equal(EXPORT_DELIVER_ERROR.destMissing, 'EXPORT_DEST_MISSING');
  assert.equal(EXPORT_DELIVER_ERROR.openPathDenied, 'EXPORT_OPEN_PATH_DENIED');
  setLocale('zh-CN');
  assert.equal(translateExportDeliverError(EXPORT_DELIVER_ERROR.destMissing), '所选导出目录不存在，请重新选择');
  assert.equal(translateExportDeliverError(EXPORT_DELIVER_ERROR.openPathDenied), '只能打开已识别的录制目录或本次选择的导出目录');
  setLocale('en');
  assert.equal(translateExportDeliverError(EXPORT_DELIVER_ERROR.destMissing), 'The chosen export folder does not exist. Choose it again.');
  assert.equal(translateExportDeliverError('some other filesystem error'), 'some other filesystem error');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
