'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

let snapshot = null;
let sessionDirectory = null;
let startedAt = null;
let stopped = false;
let faulted = false;
let sessionSequence = 0;
let postFaultInventoryCalls = 0;
let inputAudition = null;
let activeAttempt = null;
let capturedOffsetFrames = 0;
const replugScenario = process.env.DATABAKER_ACCEPTANCE_MOCK_REPLUG ?? null;
const mockUnplugAfterMs = Number(process.env.DATABAKER_ACCEPTANCE_MOCK_UNPLUG_AFTER_MS ?? 3_250);

function mockDevice(id = 'mock:usb-interface', name = 'Mock USB Audio Interface') {
  const device = {
    id,
    name,
    is_default: true,
    sample_rates: [48_000],
    input_channels: [2],
    configurations: [
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 2, sample_format: 'f32', share_mode: 'exclusive' },
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 2, sample_format: 'f32', share_mode: 'shared' },
    ],
  };
  if (process.env.DATABAKER_ACCEPTANCE_MOCK_MISSING_BACKEND !== '1') {
    device.backend = 'asio';
  }
  if (process.env.DATABAKER_ACCEPTANCE_MOCK_MISSING_REQUESTED_BUFFER !== '1') {
    device.recommended_buffer_frames = 512;
  }
  return device;
}

function mockInventory() {
  if (!replugScenario || sessionSequence === 0 || !faulted || !stopped) {
    const device = mockDevice();
    return {
      default_device_id: device.id,
      default_device_name: device.name,
      devices: [device],
    };
  }
  postFaultInventoryCalls += 1;
  if (replugScenario === 'never-disappeared') {
    const device = mockDevice();
    return {
      default_device_id: device.id,
      default_device_name: device.name,
      devices: [device],
    };
  }
  if (postFaultInventoryCalls === 1) {
    return { default_device_id: null, default_device_name: null, devices: [] };
  }
  if (replugScenario === 'different-id') {
    const device = mockDevice('mock:different-interface', 'Mock USB Audio Interface');
    return {
      default_device_id: device.id,
      default_device_name: device.name,
      devices: [device],
    };
  }
  const device = mockDevice();
  return {
    default_device_id: device.id,
    default_device_name: device.name,
    devices: [device],
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(requestId, result) {
  emit({ protocol_version: 1, request_id: requestId, ok: true, result });
}

function error(requestId, message) {
  emit({
    protocol_version: 1,
    request_id: requestId,
    ok: false,
    error: { code: 'COMMAND_FAILED', message },
  });
}

function makeWav(sampleRate, bitDepth, frames) {
  const isFloat = bitDepth === 32;
  const sampleBytes = bitDepth / 8;
  const headerLength = isFloat ? 56 : 44;
  const dataBytes = frames * sampleBytes;
  const buffer = Buffer.alloc(headerLength + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(headerLength - 8 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(isFloat ? 3 : 1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * sampleBytes, 28);
  buffer.writeUInt16LE(sampleBytes, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  let dataMarker = 36;
  if (isFloat) {
    buffer.write('fact', 36, 'ascii');
    buffer.writeUInt32LE(4, 40);
    buffer.writeUInt32LE(frames, 44);
    dataMarker = 48;
  }
  buffer.write('data', dataMarker, 'ascii');
  buffer.writeUInt32LE(dataBytes, dataMarker + 4);
  return buffer;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCsv(exported) {
  const lines = [
    'id,text,label,attempt_id,start_sample,recording_started_sample,head_silence_armed_sample,head_silence_passed_sample,required_head_silence_samples,content_started_sample,content_started_seconds,end_sample,duration_samples,file,forced_without_tail_silence,tail_silence_samples,required_tail_silence_samples',
  ];
  for (const row of exported) {
    lines.push([
      csvCell(row.id),
      csvCell(row.text),
      csvCell(row.label),
      csvCell(row.attempt_id),
      row.start_sample,
      row.recording_started_sample,
      row.head_silence_armed_sample,
      row.head_silence_passed_sample,
      row.required_head_silence_samples,
      row.content_started_sample,
      Number(row.content_started_seconds).toFixed(6),
      row.end_sample,
      row.duration_samples,
      csvCell(row.file),
      Boolean(row.forced_without_tail_silence),
      row.tail_silence_samples ?? 0,
      row.required_tail_silence_samples ?? 0,
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function sealInterruptedSession(directory) {
  const snapshotPath = path.join(directory, 'metadata', 'items.snapshot.json');
  const recovered = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const segmentDirectory = path.join(directory, 'audio', 'segments');
  const segmentNames = fs.readdirSync(segmentDirectory)
    .filter((name) => /^master-\d{6}\.wav$/i.test(name))
    .sort();
  if (segmentNames.length === 0) throw new Error('mock recovery found no segments');
  const sampleBytes = recovered.audio_format.bit_depth / 8;
  const headerLength = recovered.audio_format.bit_depth === 32 ? 56 : 44;
  let durableFrames = 0;
  for (const name of segmentNames) {
    const filePath = path.join(segmentDirectory, name);
    const bytes = fs.readFileSync(filePath);
    const frames = Math.floor(Math.max(0, bytes.length - headerLength) / sampleBytes);
    fs.writeFileSync(
      filePath,
      makeWav(recovered.audio_format.sample_rate, recovered.audio_format.bit_depth, frames),
    );
    durableFrames += frames;
  }
  recovered.status = recovered.overflow_samples > 0 ? 'faulted' : 'stopped';
  recovered.captured_samples = durableFrames;
  recovered.committed_samples = durableFrames;
  recovered.journal_seq = Number(recovered.journal_seq ?? 0) + 1;
  recovered.updated_at = new Date().toISOString();
  fs.writeFileSync(snapshotPath, `${JSON.stringify(recovered, null, 2)}\n`);
  fs.writeFileSync(
    path.join(directory, 'session.json'),
    `${JSON.stringify({
      schema_version: recovered.schema_version,
      journal_seq: recovered.journal_seq,
      session_id: recovered.session_id,
      status: recovered.status,
    }, null, 2)}\n`,
  );
  return {
    session_dir: directory,
    snapshot: recovered,
    durable_frames: durableFrames,
    recovered_attempts: 0,
    fault_preserved: recovered.status === 'faulted',
    no_op: false,
    warnings: [],
  };
}

function updateAudio() {
  if (!snapshot || stopped || faulted) return;
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1_000);
  const frames = capturedOffsetFrames + Math.floor(elapsed * snapshot.audio_format.sample_rate);
  snapshot.captured_samples = frames;
  snapshot.committed_samples = frames;
  snapshot.updated_at = new Date().toISOString();
  fs.writeFileSync(
    path.join(sessionDirectory, 'audio', 'segments', 'master-000001.wav'),
    makeWav(snapshot.audio_format.sample_rate, snapshot.audio_format.bit_depth, frames),
  );
  if (
    replugScenario &&
    sessionSequence === 1 &&
    Date.now() - startedAt >= mockUnplugAfterMs
  ) {
    faulted = true;
    snapshot.status = 'faulted';
    const marker = {
      reason: 'mock input device became unavailable',
      committed_samples: snapshot.committed_samples,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(sessionDirectory, 'metadata', 'audio-fault.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
  }
}

emit({
  protocol_version: 1,
  event: 'engine_ready',
  payload: { engine_version: 'mock-1', protocol_version: 1, platform: process.platform, arch: process.arch },
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  const requestId = command.request_id;
  switch (command.command) {
    case 'list_devices':
      response(requestId, mockInventory());
      break;
    case 'start_session': {
      const payload = command.payload;
      sessionSequence += 1;
      sessionDirectory = payload.session_dir;
      for (const directory of ['audio/segments', 'metadata', 'script', 'preview', 'export/sentences']) {
        fs.mkdirSync(path.join(sessionDirectory, directory), { recursive: true });
      }
      const now = new Date().toISOString();
      snapshot = {
        schema_version: 1,
        journal_seq: 1,
        session_id: payload.session_id,
        script_name: payload.script_name,
        status: 'recording',
        device_name: 'Mock USB Audio Interface',
        device_id:
          replugScenario === 'second-wrong-device' && sessionSequence === 2
            ? 'mock:wrong-interface'
            : 'mock:usb-interface',
        input_sample_format: 'f32',
        capture_share_mode: payload.capture_share_mode === 'shared' ? 'shared' : 'exclusive',
        audio_format: {
          sample_rate: payload.sample_rate,
          bit_depth: payload.bit_depth,
          encoding: payload.bit_depth === 32 ? 'float' : 'pcm',
          channels: 1,
          input_channels: 2,
          input_channel: payload.input_channel,
        },
        master_audio: 'audio/segments',
        storage_layout_version: 1,
        segment_frames: payload.sample_rate * 300,
        captured_samples: 0,
        committed_samples: 0,
        overflow_samples: 0,
        input_discontinuity_count: 0,
        input_discontinuity_silence_samples: 0,
        started_at: now,
        updated_at: now,
        noise_check: null,
        silence_duration_ms: payload.silence_duration_ms,
        silence_threshold_dbfs: payload.silence_threshold_dbfs,
        items: payload.items.map((item) => ({ ...item, status: 'pending', attempts: [], selected_attempt_id: null })),
      };
      if (process.env.DATABAKER_ACCEPTANCE_MOCK_MISSING_OVERFLOW === '1') {
        delete snapshot.overflow_samples;
      }
      if (process.env.DATABAKER_ACCEPTANCE_MOCK_MISSING_BACKEND !== '1') {
        snapshot.capture_backend = 'asio';
      }
      if (payload.capture_buffer_frames !== undefined) {
        snapshot.requested_capture_buffer_frames = payload.capture_buffer_frames;
      }
      if (
        payload.capture_buffer_frames !== undefined &&
        process.env.DATABAKER_ACCEPTANCE_MOCK_MISSING_ACTUAL_BUFFER !== '1'
      ) {
        snapshot.capture_buffer_frames = payload.capture_buffer_frames;
      }
      inputAudition = null;
      activeAttempt = null;
      capturedOffsetFrames = 0;
      startedAt = Date.now();
      stopped = false;
      faulted = false;
      updateAudio();
      response(requestId, {
        snapshot,
        session_dir: sessionDirectory,
        recovery_warnings: [],
        storage: { status: 'healthy', can_start: true },
      });
      break;
    }
    case 'check_noise': {
      if (process.env.DATABAKER_ACCEPTANCE_MOCK_NOISE_ERROR === '1') {
        error(requestId, 'mock ambient noise measurement failed');
        break;
      }
      const result = {
        passed: process.env.DATABAKER_ACCEPTANCE_MOCK_NOISE_FAILED !== '1',
        threshold_dbfs: command.payload.threshold_dbfs,
        average_dbfs: -70,
        maximum_dbfs: -65,
        failing_windows: 0,
        samples: [-70, -69, -71],
        completed_at: new Date().toISOString(),
      };
      snapshot.noise_check = result;
      response(requestId, result);
      break;
    }
    case 'begin_input_audition': {
      updateAudio();
      const requiredSamples = process.env.DATABAKER_ACCEPTANCE_MOCK_SHORT_AUDITION === '1'
        ? 1
        : snapshot.audio_format.sample_rate * 10;
      inputAudition = {
        status: 'recording',
        check_id: 'mock-input-audition-1',
        start_sample: snapshot.captured_samples,
        required_samples: requiredSamples,
        captured_samples: 0,
        warning_codes: [],
      };
      snapshot.input_audition = inputAudition;
      if (requiredSamples > 1) {
        // Keep integration tests fast while preserving the production protocol
        // contract: the next get_state observes a complete 10-second range and
        // later monitor deltas and fault timing still use the real wall clock.
        capturedOffsetFrames += requiredSamples;
      }
      response(requestId, {
        check_id: inputAudition.check_id,
        required_samples: inputAudition.required_samples,
        captured_samples: 0,
        input_audition: inputAudition,
        snapshot,
      });
      break;
    }
    case 'finish_input_audition': {
      updateAudio();
      if (!inputAudition || command.payload.check_id !== inputAudition.check_id) {
        error(requestId, 'mock input audition is not active');
        break;
      }
      inputAudition = {
        ...inputAudition,
        status: 'ready',
        captured_samples: inputAudition.required_samples,
        end_sample: inputAudition.start_sample + inputAudition.required_samples,
        warning_codes: [],
        metrics: {
          duration_samples: inputAudition.required_samples,
          duration_seconds: inputAudition.required_samples / snapshot.audio_format.sample_rate,
          input_discontinuity_count: 0,
          input_discontinuity_silence_samples:
            process.env.DATABAKER_ACCEPTANCE_MOCK_AUDITION_DISCONTINUITY_SILENCE === '1' ? 128 : 0,
          overflow_samples: 0,
          warning_codes: [],
        },
      };
      snapshot.input_audition = inputAudition;
      response(requestId, { input_audition: inputAudition, snapshot });
      break;
    }
    case 'confirm_input_audition': {
      if (!inputAudition || inputAudition.status !== 'ready' || command.payload.check_id !== inputAudition.check_id) {
        error(requestId, 'mock input audition cannot be confirmed');
        break;
      }
      inputAudition = { ...inputAudition, status: 'confirmed' };
      snapshot.input_audition = inputAudition;
      response(requestId, { input_audition: inputAudition, snapshot });
      break;
    }
    case 'start_attempt': {
      updateAudio();
      if (inputAudition?.status !== 'confirmed') {
        error(requestId, 'mock input audition decision required');
        break;
      }
      const item = snapshot.items.find((candidate) => candidate.id === command.payload.item_id);
      if (!item) {
        error(requestId, `unknown mock item ${command.payload.item_id}`);
        break;
      }
      activeAttempt = {
        item_id: item.id,
        attempt_id: `${item.id}-a${item.attempts.length + 1}`,
        start_sample: snapshot.captured_samples,
      };
      response(requestId, {
        attempt_id: activeAttempt.attempt_id,
        start_sample: activeAttempt.start_sample,
        recording_started_sample: activeAttempt.start_sample,
      });
      break;
    }
    case 'stop_attempt': {
      updateAudio();
      if (!activeAttempt) {
        error(requestId, 'no mock attempt is recording');
        break;
      }
      const observedDiscontinuity = process.env.DATABAKER_ACCEPTANCE_MOCK_DISCONTINUITY === '1';
      if (observedDiscontinuity) {
        snapshot.input_discontinuity_count = 1;
        snapshot.input_discontinuity_silence_samples = 128;
      }
      const item = snapshot.items.find((candidate) => candidate.id === activeAttempt.item_id);
      const attemptStatus = faulted
        ? 'interrupted'
        : observedDiscontinuity
          ? 'needs_rerecord'
          : 'recorded';
      const attempt = {
        attempt_id: activeAttempt.attempt_id,
        start_sample: activeAttempt.start_sample,
        recording_started_sample: activeAttempt.start_sample,
        head_silence_armed_sample: activeAttempt.start_sample,
        head_silence_passed_sample: activeAttempt.start_sample,
        required_head_silence_samples: 0,
        content_started_sample: activeAttempt.start_sample,
        end_sample: Math.max(activeAttempt.start_sample + 1, snapshot.captured_samples),
        forced_without_tail_silence: false,
        tail_silence_samples: snapshot.audio_format.sample_rate,
        required_tail_silence_samples: snapshot.audio_format.sample_rate,
        status: attemptStatus,
        quality_issues: observedDiscontinuity
          ? [{ code: 'input_discontinuity' }]
          : faulted
            ? [{ code: 'capture_fault' }]
            : [],
        created_at: new Date().toISOString(),
      };
      item.status = 'review';
      item.attempts.push(attempt);
      item.selected_attempt_id = null;
      activeAttempt = null;
      response(requestId, {
        item_id: item.id,
        attempt,
        forced: true,
        auto_selected: false,
        observed_discontinuity: observedDiscontinuity,
        recovered_discontinuity: observedDiscontinuity,
      });
      break;
    }
    case 'accept_attempt': {
      const item = snapshot.items.find((candidate) => candidate.id === command.payload.item_id);
      const attempt = item?.attempts.find((candidate) => candidate.attempt_id === command.payload.attempt_id);
      if (!attempt || attempt.status !== 'recorded') {
        error(requestId, 'mock attempt is not delivery safe');
        break;
      }
      attempt.status = 'accepted';
      item.status = 'accepted';
      item.selected_attempt_id = attempt.attempt_id;
      response(requestId, { item_id: item.id, attempt_id: attempt.attempt_id });
      break;
    }
    case 'get_state':
      updateAudio();
      const meterPayload = {
        captured_samples: snapshot.captured_samples,
        committed_samples: snapshot.committed_samples,
        overflow_samples: 0,
        input_discontinuity_count: snapshot.input_discontinuity_count,
        input_discontinuity_silence_samples: snapshot.input_discontinuity_silence_samples,
        faulted,
        fault_kind: faulted ? 'device_unavailable' : '',
        fault_reason: faulted ? 'mock input device became unavailable' : '',
        storage_status: 'healthy',
        storage_safe_remaining_seconds: 100_000,
        peak: 0.25,
        rms: 0.1,
        silence_samples: 0,
        waveform: [],
      };
      if (process.env.DATABAKER_ACCEPTANCE_MOCK_MISSING_OVERFLOW === '1') {
        delete meterPayload.overflow_samples;
      }
      emit({
        protocol_version: 1,
        event: 'meter',
        payload: meterPayload,
      });
      response(requestId, { snapshot, session_dir: sessionDirectory, active_attempt: null });
      break;
    case 'stop_session':
      updateAudio();
      if (replugScenario === 'second-stop-fails' && sessionSequence === 2) {
        error(requestId, 'mock second session stop failed before sealing');
        break;
      }
      stopped = true;
      snapshot.status = faulted ? 'faulted' : 'stopped';
      if (replugScenario === 'second-tail-loss' && sessionSequence === 2) {
        snapshot.captured_samples += snapshot.audio_format.sample_rate;
      }
      if (
        process.env.DATABAKER_ACCEPTANCE_MOCK_EXPORT_ACCEPTED_ITEM === '1' &&
        snapshot.items[0].attempts.length === 0
      ) {
        const item = snapshot.items[0];
        const endSample = Math.max(2, Math.min(snapshot.committed_samples, snapshot.audio_format.sample_rate));
        const attempt = {
          attempt_id: `${item.id}-a1`,
          start_sample: 0,
          recording_started_sample: 0,
          head_silence_armed_sample: 0,
          head_silence_passed_sample: 1,
          required_head_silence_samples: 1,
          content_started_sample: 1,
          end_sample: endSample,
          forced_without_tail_silence: false,
          tail_silence_samples: snapshot.audio_format.sample_rate,
          required_tail_silence_samples: snapshot.audio_format.sample_rate,
          status: 'accepted',
          created_at: new Date().toISOString(),
        };
        item.status = 'accepted';
        item.attempts = [attempt];
        item.selected_attempt_id = attempt.attempt_id;
      }
      snapshot.updated_at = new Date().toISOString();
      fs.writeFileSync(
        path.join(sessionDirectory, 'metadata', 'items.snapshot.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
      );
      fs.writeFileSync(
        path.join(sessionDirectory, 'session.json'),
        `${JSON.stringify({
          schema_version: 1,
          journal_seq: snapshot.journal_seq,
          session_id: snapshot.session_id,
          status: snapshot.status,
        }, null, 2)}\n`,
      );
      response(requestId, { session_dir: sessionDirectory, snapshot, warnings: [] });
      break;
    case 'resume_session':
      if (replugScenario && command.payload.session_dir.includes('recording-before-unplug')) {
        error(requestId, 'faulted session cannot be resumed');
      } else {
        error(requestId, 'mock resume_session is unsupported');
      }
      break;
    case 'seal_interrupted_session':
      try {
        response(requestId, sealInterruptedSession(command.payload.session_dir));
      } catch (sealError) {
        error(requestId, sealError.message);
      }
      break;
    case 'export_session': {
      if (command.payload.expected_session_id !== snapshot.session_id) {
        error(requestId, 'export session identity mismatch');
        break;
      }
      if (faulted) {
        error(requestId, 'faulted session cannot be exported normally');
        break;
      }
      if (!stopped) {
        error(requestId, 'recording is still active');
        break;
      }
      const source = path.join(sessionDirectory, 'audio', 'segments', 'master-000001.wav');
      const exportDirectory = path.join(sessionDirectory, 'export');
      const destination = path.join(exportDirectory, 'full-track.wav');
      fs.copyFileSync(source, destination);
      const exportSource = {
        journal_seq: snapshot.journal_seq,
        committed_samples: snapshot.committed_samples,
        selected_attempts: snapshot.items.map((item) => ({
          id: item.id,
          attempt_id: item.selected_attempt_id,
        })),
      };
      const exported = [];
      const skipped = [];
      for (const item of snapshot.items) {
        const attempt = item.attempts.find((candidate) => candidate.attempt_id === item.selected_attempt_id);
        if (!attempt) {
          skipped.push({ id: item.id, reason: item.status });
          continue;
        }
        const fileName = `${item.id}.wav`;
        const durationSamples = attempt.end_sample - attempt.start_sample;
        fs.writeFileSync(
          path.join(exportDirectory, 'sentences', fileName),
          makeWav(snapshot.audio_format.sample_rate, snapshot.audio_format.bit_depth, durationSamples),
        );
        exported.push({
          id: item.id,
          text: item.text,
          label: item.label,
          attempt_id: attempt.attempt_id,
          start_sample: attempt.start_sample,
          recording_started_sample: attempt.recording_started_sample,
          head_silence_armed_sample: attempt.head_silence_armed_sample,
          head_silence_passed_sample: attempt.head_silence_passed_sample,
          required_head_silence_samples: attempt.required_head_silence_samples,
          content_started_sample: attempt.content_started_sample,
          content_started_seconds: attempt.content_started_sample / snapshot.audio_format.sample_rate,
          end_sample: attempt.end_sample,
          duration_samples: durationSamples,
          file: `sentences/${fileName}`,
          forced_without_tail_silence: Boolean(attempt.forced_without_tail_silence),
          tail_silence_samples: attempt.tail_silence_samples ?? 0,
          required_tail_silence_samples: attempt.required_tail_silence_samples ?? 0,
        });
      }
      const metadata = {
        schema_version: 1,
        session_id: snapshot.session_id,
        script_name: snapshot.script_name,
        device_name: snapshot.device_name,
        device_id: snapshot.device_id,
        input_sample_format: snapshot.input_sample_format,
        audio_format: snapshot.audio_format,
        storage_layout_version: snapshot.storage_layout_version,
        segment_frames: snapshot.segment_frames,
        noise_check: snapshot.noise_check,
        silence_policy: {
          duration_ms: snapshot.silence_duration_ms,
          threshold_dbfs: snapshot.silence_threshold_dbfs,
        },
        source: exportSource,
        full_track: 'full-track.wav',
        full_track_container: 'riff',
        exported,
        skipped,
      };
      fs.writeFileSync(path.join(exportDirectory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      fs.writeFileSync(
        path.join(exportDirectory, 'metadata.csv'),
        exportCsv(exported),
      );
      fs.writeFileSync(
        path.join(exportDirectory, 'status.json'),
        `${JSON.stringify({
          schema_version: 2,
          status: 'complete',
          export_id: 'mock-export-1',
          session_id: snapshot.session_id,
          source: exportSource,
          exported_count: exported.length,
          skipped_count: process.env.DATABAKER_ACCEPTANCE_MOCK_BAD_EXPORT_MANIFEST === '1'
            ? metadata.skipped.length + 1
            : metadata.skipped.length,
        }, null, 2)}\n`,
      );
      response(requestId, {
        export_dir: exportDirectory,
        master_file: destination,
        sentences_dir: path.join(sessionDirectory, 'export', 'sentences'),
        exported_count: exported.length,
        skipped_count: skipped.length,
      });
      break;
    }
    case 'shutdown':
      if (process.env.DATABAKER_ACCEPTANCE_MOCK_SHUTDOWN === 'hang') {
        const exitAfterMs = Number(process.env.DATABAKER_ACCEPTANCE_MOCK_EXIT_AFTER_MS ?? 1_000);
        setTimeout(() => process.exit(0), exitAfterMs);
        break;
      }
      response(requestId, { shutting_down: true });
      setImmediate(() => process.exit(
        process.env.DATABAKER_ACCEPTANCE_MOCK_SHUTDOWN === 'nonzero' ? 7 : 0,
      ));
      break;
    default:
      error(requestId, `unsupported mock command ${command.command}`);
  }
});
