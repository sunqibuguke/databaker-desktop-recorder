export type LicenseReason =
  | 'unlicensed'
  | 'malformed'
  | 'bad_signature'
  | 'unknown_kid'
  | 'wrong_machine'
  | 'expired'
  | 'clock_rollback'
  | 'fingerprint_unavailable';

export type LicenseStatus = {
  state: 'valid' | 'invalid';
  reason: LicenseReason | null;
  machineCode: string;
  licensee: string | null;
  expiresAt: number | null;
  daysRemaining: number | null;
  issuedAt: number | null;
  kid: string | null;
};

export type PendingLicenseSeal = {
  session_id: string;
  session_dir: string;
  status: string;
};

export type ScriptItem = { id: string; text: string; label: string };

export type Attempt = {
  attempt_id: string;
  start_sample: number;
  recording_started_sample: number;
  head_silence_armed_sample?: number;
  head_silence_passed_sample?: number;
  required_head_silence_samples?: number;
  content_started_sample: number;
  end_sample: number;
  /** 尾静音短于任务设定；仅作记录，不阻止结束本句。 */
  forced_without_tail_silence?: boolean;
  tail_silence_samples?: number;
  required_tail_silence_samples?: number;
  /** True peak of this take, linear 0–1. Absent on older takes. */
  peak?: number;
  status: string;
  created_at: string;
};

export type HeadSilencePhase = 'idle' | 'waiting_for_head_silence' | 'ready_for_speech' | 'speech_started';

export type ItemState = ScriptItem & {
  status: 'pending' | 'review' | 'accepted' | 'skipped' | string;
  attempts: Attempt[];
  selected_attempt_id: string | null;
};

export type CaptureShareMode = 'exclusive' | 'shared';

export type CaptureProvenanceSpan = {
  start_sample: number;
  end_sample: number;
  device_name: string;
  device_id: string;
  input_sample_format: string;
  input_channels: number;
  input_channel: number;
  sample_rate: number;
};

export type SessionSnapshot = {
  schema_version: number;
  session_id: string;
  script_name?: string;
  status: string;
  device_name: string;
  device_id?: string;
  input_sample_format?: string;
  capture_share_mode?: CaptureShareMode;
  capture_provenance?: CaptureProvenanceSpan[];
  audio_format: {
    sample_rate: number;
    bit_depth: number;
    encoding?: string;
    channels: number;
    input_channels: number;
    input_channel?: number;
  };
  master_audio: string;
  storage_layout_version?: number;
  segment_frames?: number;
  captured_samples: number;
  committed_samples: number;
  overflow_samples: number;
  input_discontinuity_count?: number;
  input_discontinuity_silence_samples?: number;
  started_at: string;
  updated_at: string;
  noise_check?: NoiseCheckResult | null;
  noise_threshold_dbfs?: number;
  silence_duration_ms: number;
  silence_threshold_dbfs: number;
  items: ItemState[];
};

export type NoiseCheckResult = {
  passed: boolean;
  threshold_dbfs: number;
  average_dbfs: number;
  maximum_dbfs: number;
  failing_windows: number;
  samples: number[];
  completed_at: string;
};

export type NoiseCheckProgress = {
  sample_index: number;
  sample_count: number;
  rms_dbfs: number;
  peak_dbfs: number;
  threshold_dbfs: number;
};

export type DeviceStreamConfiguration = {
  min_sample_rate: number;
  max_sample_rate: number;
  channels: number;
  sample_format: string;
  share_mode?: CaptureShareMode;
};

export type AudioDevice = {
  id: string;
  name: string;
  is_default: boolean;
  sample_rates: number[];
  input_channels: number[];
  configurations?: DeviceStreamConfiguration[];
  exclusive_available?: boolean;
  exclusive_sample_rates?: number[];
  exclusive_input_channels?: number[];
  exclusive_formats?: string[];
  exclusive_probe_error?: string | null;
  shared_sample_rates?: number[];
  shared_input_channels?: number[];
};

export type CapturePreset = {
  id: string;
  name: string;
  deviceId: string;
  deviceName: string;
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
  inputSampleFormat?: 'i16' | 'i24' | 'i32' | 'f32';
  inputChannel: number;
  captureShareMode?: CaptureShareMode;
  silenceDurationMs: number;
  silenceThresholdDbfs: number;
};

export type CapturePresetDraft = Omit<CapturePreset, 'id'> & { id?: string };

export type CapturePresetStore = {
  schemaVersion: 1;
  lastSelectedPresetId: string | null;
  presets: CapturePreset[];
};

export type CapturePresetLoadResult = {
  store: CapturePresetStore;
  warning?: string;
};

export type Meter = {
  captured_samples: number;
  committed_samples: number;
  overflow_samples: number;
  faulted: boolean;
  fault_kind?: string;
  fault_reason?: string;
  input_discontinuity_count?: number;
  input_discontinuity_silence_samples?: number;
  capture_share_mode?: CaptureShareMode;
  storage_status: 'healthy' | 'warning' | 'critical';
  storage_safe_remaining_seconds: number;
  peak: number;
  rms: number;
  silence_samples: number;
  digital_silence_samples: number;
  digital_silence_suspected: boolean;
  last_signal_sample: number;
  head_silence_phase?: HeadSilencePhase;
  head_silence_armed_sample?: number;
  head_silence_progress_samples?: number;
  required_head_silence_samples?: number;
  head_silence_passed_sample?: number;
  content_started_sample?: number;
  silence_threshold_dbfs: number;
  silence_duration_ms: number;
  waveform: Array<[number, number]>;
  waveform_end_sample?: number;
};

export type EngineEvent = { event: string; payload: unknown; protocol_version: number };

export type EngineRecoveryFailedPayload = {
  session_dir: string;
  error: string;
};

export type ExportResult = {
  artifact?: ExportArtifact;
  export_dir: string;
  master_file?: string;
  master_container?: 'riff' | 'rf64';
  timestamps_json?: string;
  timestamps_csv?: string;
  sentences_dir?: string;
  cuts_archive?: string;
  exported_count: number;
  skipped_count: number;
  recovery_warnings?: string[];
};

export type ExportArtifact = 'full_track' | 'cuts_zip' | 'timestamps_json';

export type InspectedSessionState = {
  snapshot: SessionSnapshot;
  session_dir: string;
  mode: 'inspect';
  faulted?: boolean;
  data_health?: 'normal' | 'needs_repair' | 'readonly';
  recovery_warnings?: string[];
};

export type SealInterruptedSessionResult = {
  session_dir: string;
  snapshot: SessionSnapshot;
  durable_frames: number;
  recovered_attempts?: number;
  fault_preserved?: boolean;
  data_health?: 'normal' | 'needs_repair' | 'readonly';
  no_op: boolean;
  warnings?: string[];
};

export type PrompterCue = 'idle' | 'checking' | 'pending' | 'recording' | 'ready' | 'review' | 'complete' | 'fault';

export type PrompterState = {
  sessionName: string;
  sequence: number;
  total: number;
  id: string;
  text: string;
  label: string;
  cue: PrompterCue;
  cueLabel: string;
  readerCueLabel: string;
  silenceProgress: number;
  silenceDurationMs: number;
  qualityWarning?: string;
};

export type RecordingHistoryEntry = {
  session_id: string;
  session_dir: string;
  script_name: string;
  status: string;
  is_active: boolean;
  started_at: string;
  updated_at: string;
  device_name: string;
  sample_rate: number;
  bit_depth: number;
  encoding: string;
  input_channel: number;
  captured_samples: number;
  overflow_samples: number;
  total_items: number;
  accepted_items: number;
  skipped_items: number;
  review_items: number;
  pending_items: number;
  noise_check: NoiseCheckResult | null;
  export_exists: boolean;
  export_artifacts?: Partial<Record<ExportArtifact, ExportArtifactState>>;
  data_health?: 'normal' | 'needs_repair' | 'readonly';
  history_issue?: string;
};

export type ExportArtifactState = {
  artifact: ExportArtifact;
  state: 'never' | 'current' | 'stale' | 'failed';
  file_path?: string;
  exported_at?: string;
  exported_count?: number;
  skipped_count?: number;
  message?: string;
};

export type RecordingHistoryPage = {
  recordings: RecordingHistoryEntry[];
  next_offset: number | null;
  total_directories: number;
  scanned_directories: number;
};

export type DefaultOutputResult = {
  outputRoot: string;
  warning?: string;
};
