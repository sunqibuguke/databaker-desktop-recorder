const assert = require('node:assert/strict');
const nodeFsPromises = require('node:fs').promises;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const { CapturePresetRepository } = require('../dist-electron/capture-presets.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-presets-'));
  const file = path.join(root, 'capture-presets.json');
  let nextId = 0;
  const repository = new CapturePresetRepository(file, () => `preset-${++nextId}`, () => 1_786_377_600_000);
  const draft = {
    name: '  棚内 48k  ',
    deviceId: 'wasapi:studio',
    deviceName: 'Studio Interface',
    sampleRate: 48_000,
    bitDepth: 24,
    inputChannel: 1,
    silenceDurationMs: 1_000,
    silenceThresholdDbfs: -42,
  };

  assert.deepEqual((await repository.load()).store, {
    schemaVersion: 1,
    lastSelectedPresetId: null,
    presets: [],
  });

  const created = await repository.save(draft);
  assert.equal(created.presets[0].name, '棚内 48k', '名称必须去除首尾空格');
  assert.equal(created.lastSelectedPresetId, created.presets[0].id, '新预设应成为上次选中项');
  assert.equal('scriptFile' in created.presets[0], false, '脚本不得进入预设');
  assert.equal('outputDir' in created.presets[0], false, '保存位置不得进入预设');

  const updated = await repository.save({ ...created.presets[0], name: '棚内人声', sampleRate: 96_000 });
  assert.equal(updated.presets.length, 1);
  assert.equal(updated.presets[0].sampleRate, 96_000);
  await repository.save({ ...draft, name: 'Field', deviceId: 'wasapi:field' });
  await assert.rejects(
    repository.save({ ...draft, name: 'field' }),
    /已存在/,
    '预设名称必须不区分大小写地唯一',
  );
  await assert.rejects(
    repository.save({ ...draft, name: 'Ｆｉｅｌｄ' }),
    /已存在/,
    '全角/半角书写的同名预设也必须视为重复',
  );

  const selected = await repository.select(updated.presets[0].id);
  assert.equal(selected.lastSelectedPresetId, updated.presets[0].id);
  const afterDelete = await repository.delete(updated.presets[0].id);
  assert.equal(afterDelete.lastSelectedPresetId, null);
  assert.equal(afterDelete.presets.some((preset) => preset.id === updated.presets[0].id), false);

  await assert.rejects(repository.save({ ...draft, name: '' }), /1–40/);
  await assert.rejects(repository.save({ ...draft, inputChannel: 0 }), /输入通道/);
  await assert.rejects(repository.save({ ...draft, bitDepth: '24' }), /位深/,
    '主进程不得隐式接受渲染器传入的字符串数字');
  const manyChannelDevice = await repository.save({ ...draft, name: 'Dante 128', inputChannel: 128 });
  assert.equal(manyChannelDevice.presets.find((preset) => preset.name === 'Dante 128').inputChannel, 128,
    '预设不得将专业多通道声卡人为限制在 64 通道');
  await assert.rejects(repository.save({ ...draft, id: 'renderer-chosen-id' }), /不存在/,
    '新预设的 ID 必须由主进程生成');

  await fs.writeFile(file, '{not json', 'utf8');
  const recovered = await repository.load();
  assert.equal(recovered.store.presets.length, 0);
  assert.match(recovered.warning, /已保留/);
  const files = await fs.readdir(root);
  assert.ok(files.some((name) => name.startsWith('capture-presets.json.corrupt-')),
    '损坏文件必须保留带时间戳的副本');

  const raceRoot = path.join(root, 'race');
  const raceFile = path.join(raceRoot, 'capture-presets.json');
  let raceId = 0;
  const raceRepository = new CapturePresetRepository(raceFile, () => `race-${++raceId}`);
  const raceCount = 24;
  const concurrentResults = await Promise.all(Array.from({ length: raceCount }, (_, index) => (
    raceRepository.save({ ...draft, name: `Concurrent ${index}` })
  )));
  assert.equal(concurrentResults.length, raceCount);
  const afterConcurrentSaves = await raceRepository.load();
  assert.equal(afterConcurrentSaves.store.presets.length, raceCount,
    '并发 IPC 保存必须串行化，不得丢失先完成的更新');

  const duplicateResults = await Promise.allSettled([
    raceRepository.save({ ...draft, name: 'Concurrent duplicate' }),
    raceRepository.save({ ...draft, name: 'CONCURRENT DUPLICATE' }),
  ]);
  assert.equal(duplicateResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(duplicateResults.filter((result) => result.status === 'rejected').length, 1,
    '并发同名创建必须在同一个串行化临界区中校验');
  const afterRejectedOperation = await raceRepository.save({ ...draft, name: 'Queue still works' });
  assert.ok(afterRejectedOperation.presets.some((preset) => preset.name === 'Queue still works'),
    '单次保存失败不得永久卡住后续操作队列');

  const backupRoot = path.join(root, 'backup-failure');
  await fs.mkdir(backupRoot, { recursive: true });
  const backupFile = path.join(backupRoot, 'capture-presets.json');
  await fs.writeFile(backupFile, '{still not json', 'utf8');
  const blockedBackupPath = `${backupFile}.corrupt-123-backup-token`;
  await fs.mkdir(blockedBackupPath);
  const backupFailureRepository = new CapturePresetRepository(
    backupFile,
    () => 'backup-token',
    () => 123,
  );
  await assert.rejects(
    backupFailureRepository.load(),
    /无法创建安全备份/,
    '备份重命名失败时不得虚假声称已保留损坏文件',
  );
  assert.equal(await fs.readFile(backupFile, 'utf8'), '{still not json',
    '备份失败后必须保留原文件不变');

  const writeFailureRoot = path.join(root, 'write-failure');
  const writeFailureFile = path.join(writeFailureRoot, 'capture-presets.json');
  let writeFailureId = 0;
  const writeFailureRepository = new CapturePresetRepository(
    writeFailureFile,
    () => `write-failure-${++writeFailureId}`,
  );
  const originalOpen = nodeFsPromises.open;
  nodeFsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes('.tmp-')) {
      handle.writeFile = async () => {
        throw new Error('injected temporary write failure');
      };
    }
    return handle;
  };
  try {
    await assert.rejects(
      writeFailureRepository.save({ ...draft, name: 'Will fail' }),
      /injected temporary write failure/,
    );
  } finally {
    nodeFsPromises.open = originalOpen;
  }
  assert.deepEqual(
    (await fs.readdir(writeFailureRoot)).filter((name) => name.includes('.tmp-')),
    [],
    '写入或 fsync 失败时不得残留本次临时文件',
  );
  const savedAfterWriteFailure = await writeFailureRepository.save({ ...draft, name: 'Retry succeeds' });
  assert.equal(savedAfterWriteFailure.presets.length, 1,
    '临时写入失败后队列与仓库必须可重试');

  await fs.rm(root, { recursive: true, force: true });
  console.log('capture preset repository tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
