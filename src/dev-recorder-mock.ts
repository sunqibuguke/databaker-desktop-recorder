import type { Attempt, AudioDevice, CapturePresetDraft, CapturePresetStore, HeadSilencePhase, Meter, NoiseCheckResult, PrompterState, RecordingHistoryEntry, ScriptItem, SessionSnapshot } from './types';

type MockActiveAttempt = {
  item_id: string;
  attempt_id: string;
  start_sample: number;
  recording_started_sample: number;
  head_silence_armed_sample: number;
  head_silence_passed_sample: number;
  head_silence_progress_samples: number;
  required_head_silence_samples: number;
  head_silence_phase: HeadSilencePhase;
  content_started_sample: number;
};

export function installDevRecorderMock() {
  if ('recorder' in window) return;

  let snapshot: SessionSnapshot | null = null;
  let activeAttempt: MockActiveAttempt | null = null;
  let capturedSamples = 0;
  let previousCapturedSamples = 0;
  let waveformSampleCursor = 0;
  let silenceSamples = 0;
  let lastSignalSample = 0;
  let firstAttemptSignalSample = 0;
  let currentSessionDir = '';
  let currentExportExists = false;
  let mockSampleRate = 48_000;
  let recordingStartedAt = 0;
  let meterTimer: number | undefined;
  let capturePresetStore: CapturePresetStore = { schemaVersion: 1, lastSelectedPresetId: null, presets: [] };
  const meterListeners = new Set<(message: unknown) => void>();
  const prompterListeners = new Set<(state: PrompterState) => void>();
  const prompterChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('databaker-prompter');
  prompterChannel?.addEventListener('message', (event: MessageEvent<PrompterState>) => {
    prompterListeners.forEach((listener) => listener(event.data));
  });
  const mockDevices: AudioDevice[] = [
    { id: 'mock:studio-usb-microphone', name: 'Studio USB Microphone', is_default: true, sample_rates: [44_100, 48_000, 96_000], input_channels: [1, 2], configurations: [{ min_sample_rate: 44_100, max_sample_rate: 96_000, channels: 2, sample_format: 'f32' }] },
    { id: 'mock:built-in-microphone', name: 'Built-in Microphone', is_default: false, sample_rates: [44_100, 48_000], input_channels: [1], configurations: [{ min_sample_rate: 44_100, max_sample_rate: 48_000, channels: 1, sample_format: 'f32' }] },
  ];
  const previewHistory: RecordingHistoryEntry[] = [{
    session_id: '朗读采集-20260810-161715',
    session_dir: '/tmp/DataBaker Recordings/朗读采集-20260810-161715',
    script_name: '1000.txt',
    status: 'recording',
    is_active: false,
    started_at: '2026-08-10T16:17:15+08:00',
    updated_at: '2026-08-10T16:19:02+08:00',
    device_name: 'Studio USB Microphone',
    sample_rate: 48_000,
    bit_depth: 16,
    encoding: 'pcm',
    input_channel: 1,
    captured_samples: 6_140_416,
    overflow_samples: 0,
    total_items: 3,
    accepted_items: 0,
    skipped_items: 0,
    review_items: 0,
    pending_items: 3,
    noise_check: null,
    export_exists: false,
  }, {
    session_id: '样本补录-20260810-143522',
    session_dir: '/tmp/DataBaker Recordings/样本补录-20260810-143522',
    script_name: '补录清单.csv',
    status: 'recording',
    is_active: false,
    started_at: '2026-08-10T14:35:22+08:00',
    updated_at: '2026-08-10T15:04:09+08:00',
    device_name: 'Studio USB Microphone',
    sample_rate: 48_000,
    bit_depth: 24,
    encoding: 'pcm',
    input_channel: 1,
    captured_samples: 82_560_000,
    overflow_samples: 0,
    total_items: 20,
    accepted_items: 18,
    skipped_items: 2,
    review_items: 0,
    pending_items: 0,
    noise_check: null,
    export_exists: false,
  }, {
    session_id: '内部语料_第01批-20260809-154230',
    session_dir: '/tmp/DataBaker Recordings/内部语料_第01批-20260809-154230',
    script_name: '内部语料_第01批.csv',
    status: 'stopped',
    is_active: false,
    started_at: '2026-08-09T15:42:30+08:00',
    updated_at: '2026-08-09T17:08:12+08:00',
    device_name: 'Studio USB Microphone',
    sample_rate: 48_000,
    bit_depth: 24,
    encoding: 'pcm',
    input_channel: 1,
    captured_samples: 247_680_000,
    overflow_samples: 0,
    total_items: 320,
    accepted_items: 314,
    skipped_items: 6,
    review_items: 0,
    pending_items: 0,
    noise_check: {
      passed: true,
      threshold_dbfs: -42,
      average_dbfs: -54.2,
      maximum_dbfs: -48.8,
      failing_windows: 0,
      samples: Array.from({ length: 15 }, (_, index) => -56 + Math.sin(index) * 2),
      completed_at: '2026-08-09T15:42:34+08:00',
    },
    export_exists: true,
  }];

  function emitEvent(event: string, payload: unknown) {
    meterListeners.forEach((listener) => listener({ protocol_version: 1, event, payload }));
  }

  function snapshotCopy() {
    if (!snapshot) throw new Error('Mock 录制尚未启动');
    return structuredClone(snapshot);
  }

  function emitMeter() {
    capturedSamples = Math.max(capturedSamples, Math.floor((performance.now() - recordingStartedAt) / 1_000 * mockSampleRate));
    const newSamples = Math.max(0, capturedSamples - previousCapturedSamples);
    previousCapturedSamples = capturedSamples;
    const requiredHeadSilence = activeAttempt?.required_head_silence_samples ?? 0;
    if (activeAttempt?.head_silence_phase === 'waiting_for_head_silence') {
      activeAttempt.head_silence_progress_samples = Math.min(
        requiredHeadSilence,
        Math.max(0, capturedSamples - activeAttempt.head_silence_armed_sample),
      );
      if (activeAttempt.head_silence_progress_samples >= requiredHeadSilence) {
        activeAttempt.head_silence_passed_sample = activeAttempt.head_silence_armed_sample + requiredHeadSilence;
        activeAttempt.head_silence_phase = 'ready_for_speech';
      }
    }
    const mockReadyPauseSamples = Math.round(mockSampleRate * 0.5);
    const mockSpeechSamples = Math.round(mockSampleRate * 1.5);
    if (activeAttempt?.head_silence_phase === 'ready_for_speech'
      && capturedSamples >= activeAttempt.head_silence_passed_sample + mockReadyPauseSamples) {
      activeAttempt.content_started_sample = activeAttempt.head_silence_passed_sample + mockReadyPauseSamples;
      firstAttemptSignalSample = activeAttempt.content_started_sample;
      activeAttempt.head_silence_phase = 'speech_started';
    }
    const speaking = Boolean(activeAttempt?.content_started_sample)
      && capturedSamples < (activeAttempt?.content_started_sample ?? 0) + mockSpeechSamples;
    const pulse = speaking ? .1 + Math.abs(Math.sin(capturedSamples / 35_000)) * .22 : .0025;
    if (speaking) {
      silenceSamples = 0;
      lastSignalSample = capturedSamples;
    } else {
      silenceSamples += newSamples;
    }
    const waveformBinCount = Math.floor((capturedSamples - waveformSampleCursor) / 64);
    const waveformStartSample = waveformSampleCursor;
    waveformSampleCursor += waveformBinCount * 64;
    const waveform = Array.from({ length: waveformBinCount }, (_, index): [number, number] => {
      const position = (waveformStartSample + index * 64) / 690;
      const envelope = pulse * (.42 + .58 * Math.abs(Math.sin(position * .19)));
      const sample = Math.sin(position) * envelope;
      return [Math.min(0, sample - envelope * .18), Math.max(0, sample + envelope * .18)];
    });
    const meter: Meter = {
      captured_samples: capturedSamples,
      committed_samples: Math.max(0, capturedSamples - 2_400),
      overflow_samples: 0,
      faulted: false,
      storage_status: 'healthy',
      storage_safe_remaining_seconds: 12 * 60 * 60,
      peak: pulse,
      rms: pulse * .42,
      silence_samples: silenceSamples,
      digital_silence_samples: 0,
      digital_silence_suspected: false,
      last_signal_sample: lastSignalSample,
      head_silence_phase: activeAttempt?.head_silence_phase ?? 'idle',
      head_silence_armed_sample: activeAttempt?.head_silence_armed_sample ?? 0,
      head_silence_progress_samples: activeAttempt?.head_silence_progress_samples ?? 0,
      required_head_silence_samples: activeAttempt?.required_head_silence_samples ?? 0,
      head_silence_passed_sample: activeAttempt?.head_silence_passed_sample ?? 0,
      content_started_sample: activeAttempt?.content_started_sample ?? 0,
      silence_threshold_dbfs: snapshot?.silence_threshold_dbfs ?? -42,
      silence_duration_ms: snapshot?.silence_duration_ms ?? 1_000,
      waveform,
      waveform_end_sample: waveformSampleCursor,
    };
    emitEvent('meter', meter);
  }

  async function request<T>(command: string, payload: unknown = {}): Promise<T> {
    const data = payload as Record<string, unknown>;
    if (command === 'hello') return { engine_version: 'dev-mock', protocol_version: 1 } as T;
    if (command === 'get_state_optional') {
      if (!snapshot) return { active: false } as T;
      return {
        active: true,
        snapshot: snapshotCopy(),
        session_dir: currentSessionDir,
        active_attempt: activeAttempt,
      } as T;
    }
    if (command === 'list_devices') return {
      default_device_id: 'mock:studio-usb-microphone',
      devices: mockDevices,
    } as T;
    if (command === 'start_session') {
      capturedSamples = 0;
      previousCapturedSamples = 0;
      waveformSampleCursor = 0;
      silenceSamples = 0;
      lastSignalSample = 0;
      firstAttemptSignalSample = 0;
      currentSessionDir = String(data.session_dir);
      currentExportExists = false;
      mockSampleRate = Number(data.sample_rate) || 48_000;
      recordingStartedAt = performance.now();
      const items = data.items as ScriptItem[];
      const requestedDevice = mockDevices.find((device) => device.id === String(data.device_id));
      if (!requestedDevice) throw new Error('未找到指定的录音设备');
      const now = new Date().toISOString();
      snapshot = {
        schema_version: 1,
        session_id: String(data.session_id),
        script_name: String(data.script_name ?? ''),
        status: 'recording',
        device_name: requestedDevice.name,
        device_id: requestedDevice.id,
        input_sample_format: requestedDevice.configurations?.[0]?.sample_format ?? 'f32',
        audio_format: { sample_rate: Number(data.sample_rate), bit_depth: Number(data.bit_depth ?? 24), encoding: Number(data.bit_depth ?? 24) === 32 ? 'float' : 'pcm', channels: 1, input_channels: 2, input_channel: Number(data.input_channel ?? 1) },
        master_audio: 'audio/master.wav', storage_layout_version: 1, segment_frames: Number(data.sample_rate) * 300, captured_samples: 0, committed_samples: 0, overflow_samples: 0,
        started_at: now, updated_at: now,
        noise_check: null,
        silence_duration_ms: Number(data.silence_duration_ms ?? 1_000),
        silence_threshold_dbfs: Number(data.silence_threshold_dbfs ?? -42),
        items: items.map((item) => ({ ...item, status: 'pending', attempts: [], selected_attempt_id: null })),
      };
      meterTimer = window.setInterval(emitMeter, 100);
      return { snapshot: snapshotCopy(), session_dir: String(data.session_dir) } as T;
    }
    if (command === 'seal_interrupted_session') {
      const target = String(data.session_dir ?? '');
      const recording = previewHistory.find((candidate) => candidate.session_dir === target);
      if (!recording) throw new Error('Mock 中没有该录制任务');
      if (String(data.session_id ?? '') !== recording.session_id) throw new Error('Mock 录制任务身份不匹配');
      if (snapshot?.status === 'recording') throw new Error(`当前已有录音任务进行中：${currentSessionDir}`);
      const noOp = recording.status === 'stopped' || recording.status === 'faulted';
      recording.status = recording.overflow_samples > 0 ? 'faulted' : 'stopped';
      recording.updated_at = new Date().toISOString();
      const sealedSnapshot: SessionSnapshot = {
        schema_version: 1,
        session_id: recording.session_id,
        script_name: recording.script_name,
        status: recording.status,
        device_name: recording.device_name,
        input_sample_format: 'f32',
        audio_format: { sample_rate: recording.sample_rate, bit_depth: recording.bit_depth, encoding: recording.encoding, channels: 1, input_channels: 2, input_channel: recording.input_channel },
        master_audio: 'audio/master.wav', storage_layout_version: 1, segment_frames: recording.sample_rate * 300,
        captured_samples: recording.captured_samples, committed_samples: recording.captured_samples, overflow_samples: recording.overflow_samples,
        started_at: recording.started_at, updated_at: recording.updated_at,
        noise_check: recording.noise_check,
        silence_duration_ms: 1_000,
        silence_threshold_dbfs: -42,
        items: Array.from({ length: recording.total_items }, (_, index) => ({
          id: String(index + 1).padStart(3, '0'),
          text: `恢复录制测试文本 ${index + 1}`,
          label: index === 0 ? '自然语气' : '',
          status: index < recording.accepted_items
            ? 'accepted'
            : index < recording.accepted_items + recording.skipped_items
              ? 'skipped'
              : 'pending',
          attempts: [],
          selected_attempt_id: null,
        })),
      };
      return {
        session_dir: target,
        snapshot: sealedSnapshot,
        durable_frames: recording.captured_samples,
        recovered_attempts: 0,
        fault_preserved: recording.status === 'faulted',
        no_op: noOp,
        warnings: [],
      } as T;
    }
    if (command === 'resume_session') {
      const target = String(data.session_dir ?? '');
      if (snapshot && target === currentSessionDir) {
        capturedSamples = snapshot.captured_samples;
        previousCapturedSamples = capturedSamples;
        waveformSampleCursor = capturedSamples;
        silenceSamples = 0;
        lastSignalSample = 0;
        firstAttemptSignalSample = 0;
        mockSampleRate = snapshot.audio_format.sample_rate;
        recordingStartedAt = performance.now() - capturedSamples / mockSampleRate * 1_000;
        snapshot.status = 'recording';
        snapshot.noise_check = null;
        snapshot.updated_at = new Date().toISOString();
        window.clearInterval(meterTimer);
        meterTimer = window.setInterval(emitMeter, 100);
        return {
          snapshot: snapshotCopy(),
          session_dir: target,
          active_attempt: null,
          recovery_warnings: [],
        } as T;
      }
      const recording = previewHistory.find((candidate) => candidate.session_dir === target);
      if (!recording) throw new Error('Mock 中没有该录制任务');
      capturedSamples = recording.captured_samples;
      previousCapturedSamples = capturedSamples;
      waveformSampleCursor = capturedSamples;
      silenceSamples = 0;
      lastSignalSample = 0;
      firstAttemptSignalSample = 0;
      currentSessionDir = target;
      currentExportExists = recording.export_exists;
      mockSampleRate = recording.sample_rate;
      recordingStartedAt = performance.now() - capturedSamples / mockSampleRate * 1_000;
      snapshot = {
        schema_version: 1,
        session_id: recording.session_id,
        script_name: recording.script_name,
        status: 'recording',
        device_name: recording.device_name,
        device_id: mockDevices.find((device) => device.name === recording.device_name)?.id ?? mockDevices[0].id,
        input_sample_format: 'f32',
        audio_format: { sample_rate: recording.sample_rate, bit_depth: recording.bit_depth, encoding: recording.encoding, channels: 1, input_channels: 2, input_channel: recording.input_channel },
        master_audio: 'audio/master.wav', storage_layout_version: 1, segment_frames: recording.sample_rate * 300, captured_samples: capturedSamples, committed_samples: capturedSamples, overflow_samples: recording.overflow_samples,
        started_at: recording.started_at, updated_at: new Date().toISOString(),
        noise_check: null,
        silence_duration_ms: 1_000,
        silence_threshold_dbfs: -42,
        items: Array.from({ length: recording.total_items }, (_, index) => ({
          id: String(index + 1).padStart(3, '0'),
          text: `恢复录制测试文本 ${index + 1}`,
          label: index === 0 ? '自然语气' : '',
          status: index < recording.accepted_items ? 'accepted' : 'pending',
          attempts: [],
          selected_attempt_id: null,
        })),
      };
      window.clearInterval(meterTimer);
      meterTimer = window.setInterval(emitMeter, 100);
      return { snapshot: snapshotCopy(), session_dir: target, active_attempt: null, recovery_warnings: [] } as T;
    }
    if (command === 'export_session') {
      const target = String(data.session_dir ?? '');
      const source = snapshot && target === currentSessionDir ? snapshot : null;
      if (source) currentExportExists = true;
      else {
        const historical = previewHistory.find((recording) => recording.session_dir === target);
        if (historical) historical.export_exists = true;
      }
      const exportedCount = source
        ? source.items.filter((item) => item.status === 'accepted').length
        : previewHistory.find((recording) => recording.session_dir === target)?.accepted_items ?? 0;
      const total = source?.items.length
        ?? previewHistory.find((recording) => recording.session_dir === target)?.total_items
        ?? exportedCount;
      const exportDir = `${target || '/tmp/DataBaker Preview'}/export`;
      return { export_dir: exportDir, master_file: `${exportDir}/full-track.wav`, sentences_dir: `${exportDir}/sentences`, exported_count: exportedCount, skipped_count: total - exportedCount } as T;
    }
    if (!snapshot) throw new Error('Mock 录制尚未启动');
    if (command === 'check_noise') {
      const thresholdDbfs = Number(data.threshold_dbfs ?? -42);
      const samples: number[] = [];
      emitEvent('noise_check_started', {
        sample_count: 15,
        sample_interval_ms: 80,
        threshold_dbfs: thresholdDbfs,
      });
      for (let index = 0; index < 15; index += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        const rmsDbfs = -52 + Math.sin(index * .83) * 2.6;
        samples.push(rmsDbfs);
        emitEvent('noise_check_progress', {
          sample_index: index + 1,
          sample_count: 15,
          rms_dbfs: rmsDbfs,
          peak_dbfs: rmsDbfs + 5.2,
          threshold_dbfs: thresholdDbfs,
        });
      }
      const failingWindows = [0, 1, 2].filter((windowIndex) => samples
        .slice(windowIndex * 5, windowIndex * 5 + 5)
        .some((sample) => sample >= thresholdDbfs)).length;
      const result: NoiseCheckResult = {
        passed: failingWindows < 2,
        threshold_dbfs: thresholdDbfs,
        average_dbfs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
        maximum_dbfs: Math.max(...samples),
        failing_windows: failingWindows,
        samples,
        completed_at: new Date().toISOString(),
      };
      snapshot.noise_check = result;
      snapshot.silence_threshold_dbfs = thresholdDbfs;
      emitEvent('noise_check_completed', result);
      return result as T;
    }
    if (command === 'start_attempt') {
      const required = mockSampleRate * snapshot.silence_duration_ms / 1_000;
      const item = snapshot.items.find((candidate) => candidate.id === data.item_id)!;
      activeAttempt = {
        item_id: item.id,
        attempt_id: `${item.id}-a${item.attempts.length + 1}`,
        start_sample: capturedSamples,
        recording_started_sample: capturedSamples,
        head_silence_armed_sample: capturedSamples,
        head_silence_passed_sample: 0,
        head_silence_progress_samples: 0,
        required_head_silence_samples: required,
        head_silence_phase: 'waiting_for_head_silence',
        content_started_sample: 0,
      };
      firstAttemptSignalSample = 0;
      lastSignalSample = 0;
      silenceSamples = 0;
      return { ...activeAttempt } as T;
    }
    if (command === 'stop_attempt') {
      if (!activeAttempt) throw new Error('没有正在录制的版本');
      const force = Boolean(data.force);
      if (!firstAttemptSignalSample) {
        if (!force) throw new Error('未检测到本句有效语音');
        const itemId = activeAttempt.item_id;
        activeAttempt = null;
        return { item_id: itemId, attempt: null, discarded: true, forced: true } as T;
      }
      const requiredSilence = mockSampleRate * snapshot.silence_duration_ms / 1_000;
      const forcedWithoutTailSilence = force && silenceSamples < requiredSilence;
      if (!force && silenceSamples < requiredSilence) throw new Error('完成前静音时长不足');
      const attempt: Attempt = {
        attempt_id: activeAttempt.attempt_id,
        start_sample: Math.max(0, firstAttemptSignalSample - requiredSilence),
        recording_started_sample: activeAttempt.recording_started_sample,
        head_silence_armed_sample: activeAttempt.head_silence_armed_sample,
        head_silence_passed_sample: activeAttempt.head_silence_passed_sample,
        required_head_silence_samples: activeAttempt.required_head_silence_samples,
        content_started_sample: firstAttemptSignalSample,
        end_sample: capturedSamples,
        forced_without_tail_silence: forcedWithoutTailSilence,
        tail_silence_samples: silenceSamples,
        required_tail_silence_samples: requiredSilence,
        status: 'recorded',
        created_at: new Date().toISOString(),
      };
      const item = snapshot.items.find((candidate) => candidate.id === activeAttempt!.item_id)!;
      item.attempts.push(attempt);
      item.status = 'review';
      activeAttempt = null;
      return { item_id: item.id, attempt, forced: forcedWithoutTailSilence } as T;
    }
    if (command === 'accept_attempt') {
      const item = snapshot.items.find((candidate) => candidate.id === data.item_id)!;
      item.selected_attempt_id = String(data.attempt_id);
      item.status = 'accepted';
      item.attempts.forEach((attempt) => { attempt.status = attempt.attempt_id === data.attempt_id ? 'accepted' : 'rejected_by_operator'; });
      return { item_id: item.id, attempt_id: data.attempt_id } as T;
    }
    if (command === 'skip_item') {
      const item = snapshot.items.find((candidate) => candidate.id === data.item_id)!;
      item.status = 'skipped';
      item.selected_attempt_id = null;
      return { item_id: item.id } as T;
    }
    if (command === 'get_state') return { snapshot: snapshotCopy(), session_dir: currentSessionDir, active_attempt: activeAttempt ? { ...activeAttempt } : null } as T;
    if (command === 'render_attempt') return { file_path: '/tmp/databaker-dev-preview.wav' } as T;
    if (command === 'stop_session') {
      if (meterTimer) window.clearInterval(meterTimer);
      snapshot.status = 'stopped';
      snapshot.captured_samples = capturedSamples;
      snapshot.committed_samples = capturedSamples;
      snapshot.updated_at = new Date().toISOString();
      return { snapshot: snapshotCopy(), session_dir: String(data.session_dir ?? '/tmp/DataBaker Preview') } as T;
    }
    throw new Error(`未实现的开发预览命令：${command}`);
  }

  Object.defineProperty(window, 'recorder', {
    configurable: false,
    value: {
      runtime: 'preview',
      request,
      openScript: async () => null,
      chooseOutput: async () => '/tmp/DataBaker Recordings',
      defaultOutput: async () => ({ outputRoot: '/tmp/DataBaker Recordings' }),
      loadCapturePresets: async () => ({ store: structuredClone(capturePresetStore) }),
      saveCapturePreset: async (draft: CapturePresetDraft) => {
        const preset = { ...draft, id: draft.id || crypto.randomUUID() };
        const index = capturePresetStore.presets.findIndex((candidate) => candidate.id === preset.id);
        const presets = [...capturePresetStore.presets];
        if (index >= 0) presets[index] = preset;
        else presets.push(preset);
        capturePresetStore = { schemaVersion: 1, lastSelectedPresetId: preset.id, presets };
        return structuredClone(capturePresetStore);
      },
      deleteCapturePreset: async (id: string) => {
        capturePresetStore = {
          schemaVersion: 1,
          lastSelectedPresetId: capturePresetStore.lastSelectedPresetId === id ? null : capturePresetStore.lastSelectedPresetId,
          presets: capturePresetStore.presets.filter((preset) => preset.id !== id),
        };
        return structuredClone(capturePresetStore);
      },
      setLastCapturePreset: async (id: string | null) => {
        capturePresetStore = { ...capturePresetStore, lastSelectedPresetId: id };
        return structuredClone(capturePresetStore);
      },
      listRecordings: async (_root: string, options?: { offset?: number; limit?: number }) => {
        const rows = [...previewHistory];
        if (snapshot && currentSessionDir) {
          const items = snapshot.items;
          rows.unshift({
            session_id: snapshot.session_id,
            session_dir: currentSessionDir,
            script_name: snapshot.script_name || '未记录源文件',
            status: snapshot.status,
            is_active: snapshot.status === 'recording',
            started_at: snapshot.started_at,
            updated_at: snapshot.updated_at,
            device_name: snapshot.device_name,
            sample_rate: snapshot.audio_format.sample_rate,
            bit_depth: snapshot.audio_format.bit_depth,
            encoding: snapshot.audio_format.encoding ?? 'pcm',
            input_channel: snapshot.audio_format.input_channel ?? 1,
            captured_samples: capturedSamples,
            overflow_samples: snapshot.overflow_samples,
            total_items: items.length,
            accepted_items: items.filter((item) => item.status === 'accepted').length,
            skipped_items: items.filter((item) => item.status === 'skipped').length,
            review_items: items.filter((item) => item.status === 'review').length,
            pending_items: items.filter((item) => item.status === 'pending').length,
            noise_check: snapshot.noise_check ?? null,
            export_exists: currentExportExists,
          });
        }
        const offset = Math.max(0, options?.offset ?? 0);
        const limit = Math.max(1, options?.limit ?? 100);
        const end = Math.min(rows.length, offset + limit);
        return {
          recordings: rows.slice(offset, end),
          next_offset: end < rows.length ? end : null,
          total_directories: rows.length,
          scanned_directories: end - offset,
        };
      },
      deleteRecording: async (_root: string, sessionDir: string, sessionId: string) => {
        const index = previewHistory.findIndex((recording) => (
          recording.session_dir === sessionDir && recording.session_id === sessionId
        ));
        if (index < 0) throw new Error('Mock 中没有该录制任务');
        if (previewHistory[index].is_active) throw new Error('当前录制任务不能删除');
        previewHistory.splice(index, 1);
        return { session_dir: sessionDir, session_id: sessionId };
      },
      joinPath: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      readAudio: async () => new ArrayBuffer(44),
      openPath: async (target: string) => {
        throw new Error(`浏览器界面预览无法打开本机文件夹：${target}。请在 DataBaker 桌面应用中使用此按钮。`);
      },
      openPrompter: async () => {
        window.open(`${window.location.pathname}?view=prompter`, 'databaker-prompter', 'popup=yes,width=720,height=500');
        return true;
      },
      closePrompter: async () => window.close(),
      togglePrompterFullscreen: async () => false,
      getPrompterState: async () => {
        const serialized = window.localStorage.getItem('databaker-prompter-state');
        return serialized ? JSON.parse(serialized) as PrompterState : null;
      },
      sendPrompterState: (state: PrompterState) => {
        window.localStorage.setItem('databaker-prompter-state', JSON.stringify(state));
        prompterChannel?.postMessage(state);
      },
      onPrompterState: (listener: (state: PrompterState) => void) => { prompterListeners.add(listener); return () => prompterListeners.delete(listener); },
      onEngineEvent: (listener: (message: unknown) => void) => { meterListeners.add(listener); return () => meterListeners.delete(listener); },
      onEngineOffline: () => () => undefined,
    },
  });
}
