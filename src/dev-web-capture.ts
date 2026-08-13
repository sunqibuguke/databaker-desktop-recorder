export type DevWebCaptureHandle = {
  stop: () => void;
};

const MAX_FEED_SAMPLES = 16_384;
const PROCESSOR_BUFFER_SIZE = 4_096;
const MAX_FEED_BACKLOG = 8;

export function mixToMono(channels: ArrayLike<number>[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const length = channels[0]?.length ?? 0;
  if (channels.length === 1) {
    const only = channels[0];
    return only instanceof Float32Array ? only : Float32Array.from(only);
  }
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    output[index] = sum / channels.length;
  }
  return output;
}

export function resampleMono(input: ArrayLike<number>, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0 || !Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    return new Float32Array(0);
  }
  if (fromRate === toRate) {
    return input instanceof Float32Array ? input : Float32Array.from(input);
  }
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  const lastIndex = input.length - 1;
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * ratio;
    const left = Math.min(lastIndex, Math.floor(source));
    const right = Math.min(lastIndex, left + 1);
    const mix = source - left;
    output[index] = (input[left] ?? 0) * (1 - mix) + (input[right] ?? 0) * mix;
  }
  return output;
}

export function samplesForEngineFeed(
  channels: ArrayLike<number>[],
  fromRate: number,
  toRate: number,
): number[] {
  const resampled = resampleMono(mixToMono(channels), fromRate, toRate);
  if (resampled.length <= MAX_FEED_SAMPLES) return Array.from(resampled);
  return Array.from(resampled.subarray(0, MAX_FEED_SAMPLES));
}

async function openMicrophoneStream(preferredDeviceLabel?: string): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  const first = await navigator.mediaDevices.getUserMedia({ audio });
  const label = preferredDeviceLabel?.trim();
  if (!label) return first;
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return first;
  }
  const match = devices.find((device) => device.kind === 'audioinput' && device.label === label);
  const currentId = first.getAudioTracks()[0]?.getSettings().deviceId;
  if (!match || !match.deviceId || match.deviceId === currentId) return first;
  first.getTracks().forEach((track) => track.stop());
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...audio, deviceId: { exact: match.deviceId } },
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio });
  }
}

export async function startDevWebCapture(options: {
  sampleRate: number;
  preferredDeviceLabel?: string;
  feed: (samples: number[]) => Promise<void>;
}): Promise<DevWebCaptureHandle> {
  const stream = await openMicrophoneStream(options.preferredDeviceLabel);
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, Math.max(1, source.channelCount), 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  let stopped = false;
  let backlog = 0;
  let sending = Promise.resolve();

  processor.onaudioprocess = (event) => {
    if (stopped || backlog >= MAX_FEED_BACKLOG) return;
    const input = event.inputBuffer;
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
      channels.push(input.getChannelData(channel));
    }
    const samples = samplesForEngineFeed(channels, input.sampleRate, options.sampleRate);
    if (samples.length === 0) return;
    backlog += 1;
    sending = sending
      .then(() => {
        if (!stopped) return options.feed(samples);
      })
      .catch(() => undefined)
      .then(() => {
        backlog -= 1;
      });
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  if (context.state === 'suspended') {
    await context.resume().catch(() => undefined);
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch { /* already torn down */ }
      try { source.disconnect(); } catch { /* already torn down */ }
      try { mute.disconnect(); } catch { /* already torn down */ }
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    },
  };
}
