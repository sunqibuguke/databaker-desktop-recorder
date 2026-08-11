'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-output-root-'));
  const file = path.join(root, 'preferences', 'output-root.json');
  let token = 0;
  const { OutputRootPreferenceRepository } = require('../dist-electron/output-root-preference.js');
  const repository = new OutputRootPreferenceRepository(
    file,
    () => `token-${++token}`,
    () => 1_786_377_600_000,
  );
  const preferenceFor = async (outputRoot) => {
    const canonicalRoot = await fs.realpath(outputRoot);
    const metadata = await fs.lstat(canonicalRoot, { bigint: true });
    return {
      schemaVersion: 2,
      outputRoot: path.resolve(outputRoot),
      canonicalRoot,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      birthtimeNs: metadata.birthtimeNs.toString(),
    };
  };
  try {
    assert.deepEqual(await repository.load(), { preference: null });

    const first = path.join(root, 'external-volume', 'recordings');
    await fs.mkdir(first, { recursive: true });
    const firstPreference = await preferenceFor(first);
    assert.deepEqual(await repository.save(firstPreference), firstPreference);
    assert.deepEqual(await repository.load(), { preference: firstPreference });

    const second = path.join(root, 'larger-volume', 'recordings');
    await fs.mkdir(second, { recursive: true });
    const secondPreference = await preferenceFor(second);
    const concurrent = await Promise.all([
      repository.save(firstPreference),
      repository.save(secondPreference),
    ]);
    assert.deepEqual(concurrent.at(-1), secondPreference);
    assert.deepEqual(await repository.load(), { preference: secondPreference },
      'serialized preference writes must retain the last completed selection');

    await assert.rejects(
      repository.save({ ...secondPreference, outputRoot: 'relative/path' }),
      /无效/,
    );
    assert.deepEqual(await repository.load(), { preference: secondPreference },
      'a rejected renderer path must not replace the last valid root');

    await fs.writeFile(file, '{broken', 'utf8');
    const recovered = await repository.load();
    assert.equal(recovered.preference, null);
    assert.match(recovered.warning, /已保留/);
    assert.ok((await fs.readdir(path.dirname(file)))
      .some((name) => name.startsWith('output-root.json.corrupt-')),
    '损坏偏好必须保留备份');

    await repository.save(firstPreference);
    assert.deepEqual(
      (await fs.readdir(path.dirname(file))).filter((name) => name.includes('.tmp-')),
      [],
      '成功写入后不得残留临时文件',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('output root preference tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
