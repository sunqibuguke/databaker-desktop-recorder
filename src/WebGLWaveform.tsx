import { useEffect, useRef, useState } from 'react';
import {
  advanceWaveformPlayhead,
  reconcileWaveformBatch,
  reconcileWaveformTimelineSample,
  WAVEFORM_BIN_SAMPLES,
  waveformSampleHorizontalPosition,
  waveformWindowBinCount,
} from './waveform-buffer';

export type WaveformBin = [minimum: number, maximum: number];

type Props = {
  bins: WaveformBin[];
  capturedSamples: number;
  waveformEndSample?: number;
  recording: boolean;
  sampleRate: number;
};

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

export function WebGLWaveform({ bins, capturedSamples, waveformEndSample, recording, sampleRate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<WaveformBin[]>([]);
  const latestWaveformEndSampleRef = useRef<number | null>(null);
  const latestTimelineSampleRef = useRef<number | null>(null);
  const historyEndSampleRef = useRef<number | null>(null);
  const playheadSampleRef = useRef<number | null>(null);
  const recordingRef = useRef(recording);
  const sampleRateRef = useRef(sampleRate);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
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
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    if (sampleRateRef.current !== sampleRate) {
      historyRef.current.length = 0;
      latestWaveformEndSampleRef.current = null;
      latestTimelineSampleRef.current = null;
      historyEndSampleRef.current = null;
      playheadSampleRef.current = null;
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

    const drawWaveform = (playheadSample: number) => {
      const history = historyRef.current;
      const historyEndSample = historyEndSampleRef.current;
      if (!history.length || historyEndSample === null) return;
      // A 20-second window contains 15k bins at 48 kHz and 60k bins at
      // 192 kHz, while the canvas has only about 1.5k physical columns. Merge
      // bins that land on the same column so high sample rates do not allocate
      // and upload tens of megabytes of visually redundant vertices per second.
      const vertices = new Float32Array(Math.max(1, width) * 4);
      let vertexLines = 0;
      let currentColumn = -1;
      let columnMinimum = 1;
      let columnMaximum = -1;
      const flushColumn = () => {
        if (currentColumn < 0 || columnMaximum < columnMinimum) return;
        const x = -1 + (currentColumn + 0.5) / width * 2;
        const cursor = vertexLines * 4;
        vertices[cursor] = x;
        vertices[cursor + 1] = Math.max(-1, Math.min(1, columnMinimum * 0.92));
        vertices[cursor + 2] = x;
        vertices[cursor + 3] = Math.max(-1, Math.min(1, columnMaximum * 0.92));
        vertexLines += 1;
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
        const [minimum, maximum] = history[index];
        if (column !== currentColumn) {
          flushColumn();
          currentColumn = column;
          columnMinimum = minimum;
          columnMaximum = maximum;
        } else {
          columnMinimum = Math.min(columnMinimum, minimum);
          columnMaximum = Math.max(columnMaximum, maximum);
        }
      }
      flushColumn();
      if (!vertexLines) return;
      const color: [number, number, number, number] = recordingRef.current
        ? [0.88, 0.36, 0.40, 0.82]
        : [0.35, 0.72, 0.70, 0.78];
      uploadAndDraw(vertices.subarray(0, vertexLines * 4), gl.LINES, color);
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
      if (playheadSampleRef.current !== null) {
        drawWaveform(playheadSampleRef.current);
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
    <canvas ref={canvasRef} role="img" aria-label="实时 PCM 波形（WebGL）" />
    {!available && <span>WebGL 不可用，无法显示实时波形</span>}
  </div>;
}
