'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'electron', 'export-deliver.ts');
  const {
    bindExportDeliveryDestination,
    bindExportDeliverySource,
    deliveredExportBasename,
    deliveredExportFilePath,
    EXPORT_DELIVER_ERROR,
    exportPathsAreSameDirectory,
    exportSessionNameFromSource,
    formatExportDeliverStamp,
    isAllowedExportArtifactName,
    isExportDeliveryRequest,
    ReliableExportDeliveryManager,
  } = await import(pathToFileURL(modulePath).href);
  const i18nPath = path.join(__dirname, '..', 'src', 'export-deliver-i18n.ts');
  const { translateExportDeliverError } = await import(pathToFileURL(i18nPath).href);
  const { setLocale } = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'i18n', 'index.ts')).href);

  assert.equal(isAllowedExportArtifactName('full-track.wav'), true);
  assert.equal(isAllowedExportArtifactName('/tmp/export/cuts.zip'), true);
  assert.equal(isAllowedExportArtifactName('timestamps.json'), true);
  assert.equal(isAllowedExportArtifactName('session.json'), false);
  assert.equal(isAllowedExportArtifactName('full-track.wav.bak'), false);

  assert.equal(formatExportDeliverStamp(new Date(2026, 7, 14, 15, 30, 45)), '20260814-153045');
  assert.equal(exportSessionNameFromSource('/sessions/task-a/export/full-track.wav'), 'task-a');
  assert.equal(exportSessionNameFromSource('/sessions/bad:name/export/cuts.zip'), 'bad_name');
  assert.equal(
    deliveredExportBasename('/sessions/task-a/export/full-track.wav', '20260814-153045'),
    'task-a-full-track-20260814-153045.wav',
  );
  assert.equal(
    deliveredExportBasename('/sessions/task-a/export/cuts.zip', '20260814-153045', 1),
    'task-a-cuts-20260814-153045-2.zip',
  );
  assert.equal(
    deliveredExportFilePath('/tmp/delivery', '/sessions/task/export/full-track.wav', '20260814-153045'),
    path.join(path.resolve('/tmp/delivery'), 'task-full-track-20260814-153045.wav'),
  );
  assert.equal(exportPathsAreSameDirectory('/tmp/delivery/', '/tmp/delivery'), true);
  assert.equal(exportPathsAreSameDirectory('/tmp/delivery', '/tmp/other'), false);

  assert.equal(EXPORT_DELIVER_ERROR.destMissing, 'EXPORT_DEST_MISSING');
  assert.equal(EXPORT_DELIVER_ERROR.openPathDenied, 'EXPORT_OPEN_PATH_DENIED');
  setLocale('zh-CN');
  assert.equal(translateExportDeliverError(EXPORT_DELIVER_ERROR.destMissing), '所选导出目录不存在，请重新选择');
  assert.equal(translateExportDeliverError(EXPORT_DELIVER_ERROR.openPathDenied), '只能打开已识别的录制目录或本次选择的导出目录');
  setLocale('en');
  assert.equal(translateExportDeliverError(EXPORT_DELIVER_ERROR.destMissing), 'The chosen export folder does not exist. Choose it again.');
  assert.equal(translateExportDeliverError('some other filesystem error'), 'some other filesystem error');

  const [mainSource, preloadSource] = await Promise.all([
    readFile(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf8'),
    readFile(path.join(__dirname, '..', 'electron', 'preload.ts'), 'utf8'),
  ]);
  assert.doesNotMatch(mainSource, /payload\.source_file/, 'renderer-provided source paths must not be accepted');
  assert.doesNotMatch(preloadSource, /source_file:\s*sourceFile/, 'preload must not recreate the legacy source-path payload');
  for (const channel of [
    'export:deliver-artifact',
    'export:cancel-delivery',
    'export:verify-delivery',
  ]) {
    assert.match(mainSource, new RegExp(channel));
    assert.match(preloadSource, new RegExp(channel));
  }
  assert.match(preloadSource, /export:delivery-progress/);

  assert.equal(isExportDeliveryRequest({
    request_id: 'request-1',
    session_id: 'session-1',
    artifact: 'cuts_zip',
    export_id: 'export-1',
    destination_dir: '/tmp/delivery',
  }), true);
  assert.equal(isExportDeliveryRequest({
    request_id: 'request-1',
    session_id: 'session-1',
    artifact: 'cuts_zip',
    export_id: '',
    destination_dir: '/tmp/delivery',
  }), false);

  const root = await mkdtemp(path.join(os.tmpdir(), 'databaker-delivery-'));
  try {
    const createFixture = async (label, bytes = 2_500_000) => {
      const sessionId = `session-${label}`;
      const exportId = `export-${label}`;
      const sessionDir = path.join(root, `task-${label}`);
      const exportDir = path.join(sessionDir, 'export');
      const destinationDir = path.join(root, `destination-${label}`);
      await mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
      await mkdir(exportDir, { recursive: true });
      await mkdir(destinationDir, { recursive: true });
      const sourceFile = path.join(exportDir, 'cuts.zip');
      const statusFile = path.join(exportDir, 'status-cuts-zip.json');
      const sourceBytes = Buffer.alloc(bytes, label.charCodeAt(0) || 0x5a);
      const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
      await writeFile(sourceFile, sourceBytes);
      const writeStatus = async (nextExportId = exportId) => writeFile(statusFile, `${JSON.stringify({
        schema_version: 2,
        status: 'complete',
        session_id: sessionId,
        artifact: 'cuts_zip',
        export_id: nextExportId,
        sha256: sourceSha256,
      })}\n`);
      await writeStatus();
      const destinationBinding = await bindExportDeliveryDestination(destinationDir);
      const makeManager = (onProgress, testHooks) => new ReliableExportDeliveryManager({
        resolveSource: (request) => bindExportDeliverySource(sessionDir, request),
        resolveDestination: async () => destinationBinding,
        resolveSessionDir: async () => sessionDir,
        onProgress,
        testHooks,
        now: () => new Date('2026-08-27T08:09:10.000Z'),
      });
      const request = {
        request_id: `request-${label}`,
        session_id: sessionId,
        artifact: 'cuts_zip',
        export_id: exportId,
        destination_dir: destinationDir,
      };
      return {
        sessionId,
        exportId,
        sessionDir,
        exportDir,
        destinationDir,
        destinationBinding,
        sourceFile,
        sourceSha256,
        statusFile,
        writeStatus,
        makeManager,
        request,
      };
    };

    const healthy = await createFixture('healthy');
    const progress = [];
    const manager = healthy.makeManager((entry) => progress.push(entry));
    const delivered = await manager.deliver(healthy.request);
    assert.equal(delivered.session_id, healthy.sessionId);
    assert.equal(delivered.export_id, healthy.exportId);
    assert.equal(delivered.verification, 'verified');
    assert.equal(delivered.copied, true);
    assert.equal((await stat(delivered.file_path)).size, (await stat(healthy.sourceFile)).size);
    assert.deepEqual(await readFile(delivered.file_path), await readFile(healthy.sourceFile));
    assert.match(delivered.sha256, /^[a-f0-9]{64}$/);
    assert.equal(progress[0].stage, 'validating');
    assert.equal(progress.some((entry) => entry.stage === 'copying'), true);
    assert.equal(progress.at(-1).stage, 'writing_receipt');
    const receipt = JSON.parse(await readFile(delivered.receipt_path, 'utf8'));
    assert.equal(receipt.export_id, healthy.exportId);
    assert.equal(receipt.source_sha256, delivered.sha256);
    await assert.rejects(
      manager.deliver(healthy.request),
      new RegExp(EXPORT_DELIVER_ERROR.requestDuplicate),
    );
    assert.equal(
      (await readdir(healthy.destinationDir)).filter((name) => !name.endsWith('.partial')).length,
      1,
      'replaying a completed request must not publish a second artifact',
    );

    const restartedManager = healthy.makeManager();
    const verified = await restartedManager.verify({
      session_id: healthy.sessionId,
      artifact: 'cuts_zip',
      export_id: healthy.exportId,
    });
    assert.equal(verified.verification, 'verified');
    assert.equal(verified.file_path, delivered.file_path);

    const outsideSameHash = path.join(root, 'outside-same-hash.zip');
    await writeFile(outsideSameHash, await readFile(healthy.sourceFile));
    await writeFile(delivered.receipt_path, `${JSON.stringify({
      ...receipt,
      destination_file: outsideSameHash,
    }, null, 2)}\n`);
    const outsideReceipt = await restartedManager.verify({
      session_id: healthy.sessionId,
      artifact: 'cuts_zip',
      export_id: healthy.exportId,
    });
    assert.equal(
      outsideReceipt.verification,
      'invalid',
      'a tampered receipt cannot verify a same-hash file outside its bound destination directory',
    );
    await writeFile(delivered.receipt_path, `${JSON.stringify({
      ...receipt,
      source_file: outsideSameHash,
    }, null, 2)}\n`);
    const reboundSourceReceipt = await restartedManager.verify({
      session_id: healthy.sessionId,
      artifact: 'cuts_zip',
      export_id: healthy.exportId,
    });
    assert.equal(
      reboundSourceReceipt.verification,
      'invalid',
      'a receipt source path must stay bound to the current export artifact',
    );
    await writeFile(delivered.receipt_path, `${JSON.stringify(receipt, null, 2)}\n`);

    const staleAtStart = await createFixture('stale-start', 64);
    await assert.rejects(
      staleAtStart.makeManager().deliver({ ...staleAtStart.request, export_id: 'wrong-export' }),
      new RegExp(EXPORT_DELIVER_ERROR.exportStale),
    );
    assert.deepEqual(await readdir(staleAtStart.destinationDir), []);

    if (process.platform !== 'win32') {
      const linkedStatus = await createFixture('linked-status', 64);
      const outsideStatus = path.join(root, 'outside-status.json');
      await writeFile(outsideStatus, await readFile(linkedStatus.statusFile));
      await rm(linkedStatus.statusFile);
      await symlink(outsideStatus, linkedStatus.statusFile);
      await assert.rejects(
        linkedStatus.makeManager().deliver(linkedStatus.request),
        new RegExp(EXPORT_DELIVER_ERROR.exportStale),
        'an export generation marker must be a direct regular file inside the task export directory',
      );
      assert.deepEqual(await readdir(linkedStatus.destinationDir), []);
    }

    const staleDuringCopy = await createFixture('stale-copy');
    let staleChanged = false;
    const staleManager = staleDuringCopy.makeManager((entry) => {
      if (!staleChanged && entry.stage === 'copying') {
        staleChanged = true;
        writeFileSync(staleDuringCopy.statusFile, `${JSON.stringify({
          schema_version: 2,
          status: 'complete',
          session_id: staleDuringCopy.sessionId,
          artifact: 'cuts_zip',
          export_id: 'newer-export',
          sha256: staleDuringCopy.sourceSha256,
        })}\n`);
      }
    });
    await assert.rejects(
      staleManager.deliver(staleDuringCopy.request),
      new RegExp(EXPORT_DELIVER_ERROR.exportStale),
    );
    assert.equal((await readdir(staleDuringCopy.destinationDir)).some((name) => !name.endsWith('.partial')), false);

    const cancelled = await createFixture('cancelled');
    let cancelCalled = false;
    let cancelManager;
    cancelManager = cancelled.makeManager((entry) => {
      if (!cancelCalled && entry.stage === 'copying') {
        cancelCalled = true;
        assert.equal(cancelManager.cancel(cancelled.request.request_id), true);
      }
    });
    await assert.rejects(
      cancelManager.deliver(cancelled.request),
      new RegExp(EXPORT_DELIVER_ERROR.cancelled),
    );
    assert.deepEqual(await readdir(cancelled.destinationDir), []);
    assert.equal(cancelManager.cancel(cancelled.request.request_id), false);

    const targetReplaced = await createFixture('target-replaced');
    const displacedDestination = `${targetReplaced.destinationDir}-old`;
    let targetChanged = false;
    const targetManager = targetReplaced.makeManager(undefined, {
      beforePublish: () => {
        if (targetChanged) return;
        targetChanged = true;
        renameSync(targetReplaced.destinationDir, displacedDestination);
        mkdirSync(targetReplaced.destinationDir);
      },
    });
    await assert.rejects(
      targetManager.deliver(targetReplaced.request),
      new RegExp(EXPORT_DELIVER_ERROR.destReplaced),
    );
    assert.deepEqual(await readdir(targetReplaced.destinationDir), []);
    assert.equal((await readdir(displacedDestination)).some((name) => !name.endsWith('.partial')), false);

    const sourceReplaced = await createFixture('source-replaced');
    const oldSource = `${sourceReplaced.sourceFile}.old`;
    let sourceChanged = false;
    const sourceManager = sourceReplaced.makeManager((entry) => {
      if (!sourceChanged && entry.stage === 'copying') {
        sourceChanged = true;
        renameSync(sourceReplaced.sourceFile, oldSource);
        writeFileSync(sourceReplaced.sourceFile, Buffer.alloc(2_500_000, 0x11));
      }
    });
    await assert.rejects(
      sourceManager.deliver(sourceReplaced.request),
      new RegExp(EXPORT_DELIVER_ERROR.sourceReplaced),
    );
    assert.equal((await readdir(sourceReplaced.destinationDir)).some((name) => !name.endsWith('.partial')), false);

    const sourceTampered = await createFixture('source-tampered', 128);
    await writeFile(sourceTampered.sourceFile, Buffer.alloc(128, 0x33));
    await assert.rejects(
      sourceTampered.makeManager().deliver(sourceTampered.request),
      new RegExp(EXPORT_DELIVER_ERROR.sourceInvalid),
      'content changed without a new status/export_id must never receive a receipt',
    );
    assert.deepEqual(await readdir(sourceTampered.destinationDir), []);

    for (const code of ['ENOSPC', 'EIO']) {
      const fault = await createFixture(`fault-${code.toLowerCase()}`);
      let injected = false;
      const faultManager = fault.makeManager(undefined, {
        beforeChunkWrite: () => {
          if (injected) return;
          injected = true;
          throw Object.assign(new Error(`injected ${code}`), { code });
        },
      });
      await assert.rejects(
        faultManager.deliver(fault.request),
        (error) => error && error.code === code,
      );
      assert.deepEqual(await readFile(fault.sourceFile), Buffer.alloc(
        2_500_000,
        `fault-${code.toLowerCase()}`.charCodeAt(0),
      ));
      assert.deepEqual(await readdir(fault.destinationDir), []);
      assert.deepEqual(await readdir(path.join(fault.exportDir, 'delivery-receipts')), []);
    }

    const collision = await createFixture('collision', 256);
    const collisionStamp = `${formatExportDeliverStamp(new Date('2026-08-27T08:09:10.000Z'))}-${createHash('sha256')
      .update(collision.request.request_id)
      .digest('hex')
      .slice(0, 8)}`;
    const occupiedName = deliveredExportFilePath(
      collision.destinationDir,
      collision.sourceFile,
      collisionStamp,
    );
    await writeFile(occupiedName, 'pre-existing delivery');
    const collisionResult = await collision.makeManager().deliver(collision.request);
    assert.notEqual(collisionResult.file_path, occupiedName);
    assert.equal(await readFile(occupiedName, 'utf8'), 'pre-existing delivery');
    assert.match(path.basename(collisionResult.file_path), /-2\.zip$/);

    const fallbackRace = await createFixture('fallback-race', 256);
    const fallbackStamp = `${formatExportDeliverStamp(new Date('2026-08-27T08:09:10.000Z'))}-${createHash('sha256')
      .update(fallbackRace.request.request_id)
      .digest('hex')
      .slice(0, 8)}`;
    const competingFile = deliveredExportFilePath(
      fallbackRace.destinationDir,
      fallbackRace.sourceFile,
      fallbackStamp,
    );
    let competitorCreated = false;
    const fallbackRaceManager = fallbackRace.makeManager(undefined, {
      forceCopyPublishFallback: true,
      beforePublish: async ({ file_path: filePath }) => {
        if (competitorCreated) return;
        competitorCreated = true;
        assert.equal(path.basename(filePath), path.basename(competingFile));
        await writeFile(filePath, 'competing user file');
      },
    });
    const fallbackRaceResult = await fallbackRaceManager.deliver(fallbackRace.request);
    assert.equal(
      await readFile(competingFile, 'utf8'),
      'competing user file',
      'the removable-filesystem fallback must never overwrite a file created during copy',
    );
    assert.notEqual(fallbackRaceResult.file_path, competingFile);
    assert.match(path.basename(fallbackRaceResult.file_path), /-2\.zip$/);
    assert.deepEqual(
      await readFile(fallbackRaceResult.file_path),
      await readFile(fallbackRace.sourceFile),
    );

    const afterPublish = await createFixture('after-publish', 512);
    let crashInjected = false;
    const crashingManager = afterPublish.makeManager(undefined, {
      afterPublishBeforeReceipt: () => {
        if (crashInjected) return;
        crashInjected = true;
        throw new Error('injected crash after publish');
      },
    });
    await assert.rejects(
      crashingManager.deliver(afterPublish.request),
      /injected crash after publish/,
    );
    const orphaned = (await readdir(afterPublish.destinationDir))
      .filter((name) => !name.endsWith('.partial'));
    assert.equal(orphaned.length, 1, 'an atomically published file may remain for forensic recovery');
    assert.deepEqual(await readdir(path.join(afterPublish.exportDir, 'delivery-receipts')), []);
    assert.equal(await crashingManager.verify({
      session_id: afterPublish.sessionId,
      artifact: 'cuts_zip',
      export_id: afterPublish.exportId,
    }), null, 'an orphan without a receipt is never a verified delivery');
    const retried = await afterPublish.makeManager().deliver(afterPublish.request);
    assert.notEqual(path.basename(retried.file_path), orphaned[0]);
    assert.equal((await readdir(afterPublish.destinationDir)).filter((name) => !name.endsWith('.partial')).length, 2);
    assert.equal((await afterPublish.makeManager().verify({
      session_id: afterPublish.sessionId,
      artifact: 'cuts_zip',
      export_id: afterPublish.exportId,
    })).verification, 'verified');

    await healthy.writeStatus('newer-export-after-restart');
    const staleReceipt = await restartedManager.verify({
      session_id: healthy.sessionId,
      artifact: 'cuts_zip',
      export_id: healthy.exportId,
    });
    assert.equal(staleReceipt.verification, 'stale');

    await healthy.writeStatus();
    await writeFile(delivered.file_path, 'tampered');
    const invalidReceipt = await restartedManager.verify({
      session_id: healthy.sessionId,
      artifact: 'cuts_zip',
      export_id: healthy.exportId,
    });
    assert.equal(invalidReceipt.verification, 'invalid');

    await rm(delivered.file_path);
    const missingReceipt = await restartedManager.verify({
      session_id: healthy.sessionId,
      artifact: 'cuts_zip',
      export_id: healthy.exportId,
    });
    assert.equal(missingReceipt.verification, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
