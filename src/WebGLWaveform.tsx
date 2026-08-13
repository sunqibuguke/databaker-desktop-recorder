import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import {
  advanceWaveformPlayhead,
  pruneWaveformTakeSpans,
  reconcileWaveformBatch,
  reconcileWaveformTakeSpans,
  reconcileWaveformTimelineSample,
  sampleIsRecordedTake,
  WAVEFORM_BIN_SAMPLES,
  reviewBinHorizontalPosition,
  waveformSampleHorizontalPosition,
  waveformWindowBinCount,
  waveformWindowStartSample,
  type WaveformTakeSpan,
} from './waveform-buffer';

export type WaveformBin = [minimum: number, maximum: number];

type Props = {
  bins: WaveformBin[];
  capturedSamples: number;
  waveformEndSample?: number;
  recording: boolean;
  takeStartSample?: number;
  sampleRate: number;
  mode?: 'live' | 'review';
};

const IDLE_WAVE_COLOR: [number, number, number, number] = [0.35, 0.72, 0.70, 0.78];
const RECORDED_WAVE_COLOR: [number, number, number, number] = [0.88, 0.36, 0.40, 0.82];
const RECORDED_BAND_COLOR: [number, number, number, number] = [0.88, 0.36, 0.40, 0.12];
const TAKE_MARKER_COLOR: [number, number, number, number] = [0.98, 0.90, 0.90, 0.95];

const vertexShaderSource = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  uniform vec4 u_color;
  void main() {
    gl_FragColor = u_color;
  }
`;

function createProgram(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('无法创建 WebGL shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'WebGL shader 编译失败';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexShaderSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WebGL program 链接失败';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

export function WebGLWaveform({
  bins,
  capturedSamples,
  waveformEndSample,
  recording,
  takeStartSample,
  sampleRate,
  mode = 'live',
}: Props) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<WaveformBin[]>([]);
  const latestWaveformEndSampleRef = useRef<number | null>(null);
  const latestTimelineSampleRef = useRef<number | null>(null);
  const historyEndSampleRef = useRef<number | null>(null);
  const playheadSampleRef = useRef<number | null>(null);
  const takesRef = useRef<WaveformTakeSpan[]>([]);
  const sampleRateRef = useRef(sampleRate);
  const modeRef = useRef(mode);
  const reviewBinsRef = useRef<WaveformBin[]>(mode === 'review' ? bins : []);
  modeRef.current = mode;
  if (mode === 'review') reviewBinsRef.current = bins;
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (mode === 'review') return;
    const timelineSample = reconcileWaveformTimelineSample(
      capturedSamples,
      waveformEndSample,
      latestTimelineSampleRef.current,
    );
    latestTimelineSampleRef.current = timelineSample;
    playheadSampleRef.current = playheadSampleRef.current === null
      ? timelineSample
      : advanceWaveformPlayhead(
        playheadSampleRef.current,
        timelineSample,
        0,
        sampleRateRef.current,
      );

    if (!bins.length) return;
    const reconciled = reconcileWaveformBatch(
      bins,
      waveformEndSample,
      latestWaveformEndSampleRef.current,
    );
    if (!reconciled.bins.length) return;
    if (reconciled.reset) {
      historyRef.current.length = 0;
    }
    latestWaveformEndSampleRef.current = reconciled.endSample;
    historyEndSampleRef.current = reconciled.endSample;
    if (reconciled.reset) playheadSampleRef.current = timelineSample;

    // Preview packets are already live capture data. Put them on screen as
    // soon as they cross IPC; replaying them through another real-time queue
    // adds latency and turns renderer hiccups into visible catch-up bursts.
    historyRef.current.push(...reconciled.bins);
    const maximumBins = waveformWindowBinCount(sampleRateRef.current);
    if (historyRef.current.length > maximumBins) {
      historyRef.current.splice(0, historyRef.current.length - maximumBins);
    }
  }, [bins, capturedSamples, waveformEndSample]);

  useEffect(() => {
    const cursor = latestTimelineSampleRef.current ?? capturedSamples;
    takesRef.current = reconcileWaveformTakeSpans(
      takesRef.current,
      recording,
      takeStartSample,
      cursor,
    );
  }, [recording, takeStartSample, capturedSamples]);

  useEffect(() => {
    if (sampleRateRef.current !== sampleRate) {
      historyRef.current.length = 0;
      latestWaveformEndSampleRef.current = null;
      latestTimelineSampleRef.current = null;
      historyEndSampleRef.current = null;
      playheadSampleRef.current = null;
      takesRef.current = [];
    }
    sampleRateRef.current = sampleRate;
  }, [sampleRate]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    }) ?? canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      setAvailable(false);
      return;
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl);
    } catch {
      setAvailable(false);
      return;
    }
    setAvailable(true);
    const buffer = gl.createBuffer();
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const colorLocation = gl.getUniformLocation(program, 'u_color');
    if (!buffer || positionLocation < 0 || !colorLocation) {
      setAvailable(false);
      return;
    }

    let width = 0;
    let height = 0;
    let frame = 0;
    let lastFrameAt = performance.now();

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(bounds.width * ratio));
      height = Math.max(1, Math.round(bounds.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    };

    const uploadAndDraw = (vertices: Float32Array, mode: number, color: [number, number, number, number]) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(positionLocation);
      gl.uniform4fv(colorLocation, color);
      gl.drawArrays(mode, 0, vertices.length / 2);
    };

    const drawGrid = () => {
      const vertices: number[] = [];
      for (let index = 0; index <= 5; index += 1) {
        const y = -1 + index * 0.4;
        vertices.push(-1, y, 1, y);
      }
      for (let index = 0; index <= 10; index += 1) {
        const x = -1 + index * 0.2;
        vertices.push(x, -1, x, 1);
      }
      uploadAndDraw(new Float32Array(vertices), gl.LINES, [0.12, 0.19, 0.18, 0.72]);
    };

    const drawQuad = (
      left: number,
      right: number,
      color: [number, number, number, number],
    ) => {
      if (right <= left) return;
      uploadAndDraw(new Float32Array([
        left, -1, right, -1, left, 1,
        left, 1, right, -1, right, 1,
      ]), gl.TRIANGLES, color);
    };

    const drawTakeBands = (playheadSample: number, takes: WaveformTakeSpan[]) => {
      const rate = sampleRateRef.current;
      for (const take of takes) {
        const startX = waveformSampleHorizontalPosition(take.startSample, playheadSample, rate);
        const endX = take.endSample === null
          ? 1
          : waveformSampleHorizontalPosition(take.endSample, playheadSample, rate);
        drawQuad(Math.max(-1, startX), Math.min(1, endX), RECORDED_BAND_COLOR);
      }
    };

    const drawTakeMarkers = (playheadSample: number, takes: WaveformTakeSpan[]) => {
      const rate = sampleRateRef.current;
      const halfWidth = Math.max(1.5, width / 900) / Math.max(1, width) * 2;
      for (const take of takes) {
        const startX = waveformSampleHorizontalPosition(take.startSample, playheadSample, rate);
        if (startX >= -1 && startX <= 1) {
          drawQuad(startX - halfWidth, startX + halfWidth, TAKE_MARKER_COLOR);
        }
        if (take.endSample === null) continue;
        const endX = waveformSampleHorizontalPosition(take.endSample, playheadSample, rate);
        if (endX >= -1 && endX <= 1) {
          drawQuad(endX - halfWidth, endX + halfWidth, TAKE_MARKER_COLOR);
        }
      }
    };

    const drawReviewWaveform = (reviewBins: WaveformBin[]) => {
      if (!reviewBins.length) return;
      const columnCapacity = Math.max(1, width) * 4;
      const vertices = new Float32Array(columnCapacity);
      let lines = 0;
      let currentColumn = -1;
      let columnMinimum = 1;
      let columnMaximum = -1;
      const flushColumn = () => {
        if (currentColumn < 0 || columnMaximum < columnMinimum) return;
        const x = -1 + (currentColumn + 0.5) / width * 2;
        const cursor = lines * 4;
        vertices[cursor] = x;
        vertices[cursor + 1] = Math.max(-1, Math.min(1, columnMinimum * 0.92));
        vertices[cursor + 2] = x;
        vertices[cursor + 3] = Math.max(-1, Math.min(1, columnMaximum * 0.92));
        lines += 1;
      };
      for (let index = 0; index < reviewBins.length; index += 1) {
        const x = reviewBinHorizontalPosition(index, reviewBins.length);
        const column = Math.max(0, Math.min(width - 1, Math.floor((x + 1) * width / 2)));
        if (column !== currentColumn) {
          flushColumn();
          currentColumn = column;
          columnMinimum = 1;
          columnMaximum = -1;
        }
        columnMinimum = Math.min(columnMinimum, reviewBins[index][0]);
        columnMaximum = Math.max(columnMaximum, reviewBins[index][1]);
      }
      flushColumn();
      if (lines) uploadAndDraw(vertices.subarray(0, lines * 4), gl.LINES, RECORDED_WAVE_COLOR);
    };

    const drawWaveform = (playheadSample: number, takes: WaveformTakeSpan[]) => {
      const history = historyRef.current;
      const historyEndSample = historyEndSampleRef.current;
      if (!history.length || historyEndSample === null) return;
      // A 20-second window contains 15k bins at 48 kHz and 60k bins at
      // 192 kHz, while the canvas has only about 1.5k physical columns. Merge
      // bins that land on the same column so high sample rates do not allocate
      // and upload tens of megabytes of visually redundant vertices per second.
      const columnCapacity = Math.max(1, width) * 4;
      const idleVertices = new Float32Array(columnCapacity);
      const recordedVertices = new Float32Array(columnCapacity);
      let idleLines = 0;
      let recordedLines = 0;
      let currentColumn = -1;
      let columnMinimum = 1;
      let columnMaximum = -1;
      let columnRecorded = false;
      const flushColumn = () => {
        if (currentColumn < 0 || columnMaximum < columnMinimum) return;
        const x = -1 + (currentColumn + 0.5) / width * 2;
        const vertices = columnRecorded ? recordedVertices : idleVertices;
        const cursor = (columnRecorded ? recordedLines : idleLines) * 4;
        vertices[cursor] = x;
        vertices[cursor + 1] = Math.max(-1, Math.min(1, columnMinimum * 0.92));
        vertices[cursor + 2] = x;
        vertices[cursor + 3] = Math.max(-1, Math.min(1, columnMaximum * 0.92));
        if (columnRecorded) recordedLines += 1;
        else idleLines += 1;
      };
      for (let index = 0; index < history.length; index += 1) {
        const binCenterSample = historyEndSample
          - (history.length - index - 0.5) * WAVEFORM_BIN_SAMPLES;
        const x = waveformSampleHorizontalPosition(
          binCenterSample,
          playheadSample,
          sampleRateRef.current,
        );
        if (x < -1 || x > 1) continue;
        const column = Math.max(0, Math.min(width - 1, Math.floor((x + 1) * width / 2)));
        const recorded = sampleIsRecordedTake(binCenterSample, takes);
        const [minimum, maximum] = history[index];
        if (column !== currentColumn || recorded !== columnRecorded) {
          flushColumn();
          currentColumn = column;
          columnRecorded = recorded;
          columnMinimum = minimum;
          columnMaximum = maximum;
        } else {
          columnMinimum = Math.min(columnMinimum, minimum);
          columnMaximum = Math.max(columnMaximum, maximum);
        }
      }
      flushColumn();
      if (idleLines) {
        uploadAndDraw(idleVertices.subarray(0, idleLines * 4), gl.LINES, IDLE_WAVE_COLOR);
      }
      if (recordedLines) {
        uploadAndDraw(recordedVertices.subarray(0, recordedLines * 4), gl.LINES, RECORDED_WAVE_COLOR);
      }
    };

    const render = (now: number) => {
      const elapsed = Math.max(0, now - lastFrameAt);
      lastFrameAt = now;
      const latestTimelineSample = latestTimelineSampleRef.current;
      if (latestTimelineSample !== null) {
        playheadSampleRef.current = advanceWaveformPlayhead(
          playheadSampleRef.current ?? latestTimelineSample,
          latestTimelineSample,
          elapsed,
          sampleRateRef.current,
        );
      }

      // backgroundThrottling is disabled so telemetry can still be consumed
      // and acknowledged while recording on another display. Do not spend GPU
      // time rebuilding an invisible scope when the window is actually hidden;
      // the authoritative sample cursor above still keeps the next visible
      // frame current.
      if (document.visibilityState === 'hidden') {
        frame = requestAnimationFrame(render);
        return;
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawGrid();
      if (modeRef.current === 'review') {
        drawReviewWaveform(reviewBinsRef.current);
        frame = requestAnimationFrame(render);
        return;
      }
      if (playheadSampleRef.current !== null) {
        takesRef.current = pruneWaveformTakeSpans(
          takesRef.current,
          waveformWindowStartSample(playheadSampleRef.current, sampleRateRef.current),
        );
        const takes = takesRef.current;
        drawTakeBands(playheadSampleRef.current, takes);
        drawWaveform(playheadSampleRef.current, takes);
        drawTakeMarkers(playheadSampleRef.current, takes);
      }
      frame = requestAnimationFrame(render);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  return <div className="webgl-waveform" data-renderer={available ? 'webgl' : 'unavailable'}>
    <canvas ref={canvasRef} role="img" aria-label={t('waveform.aria')} />
    {!available && <span>{t('waveform.unavailable')}</span>}
  </div>;
}
