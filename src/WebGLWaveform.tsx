import { useEffect, useRef, useState } from 'react';

export type WaveformBin = [minimum: number, maximum: number];

type Props = {
  bins: WaveformBin[];
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

export function WebGLWaveform({ bins, recording, sampleRate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingRef = useRef<WaveformBin[]>([]);
  const recordingRef = useRef(recording);
  const sampleRateRef = useRef(sampleRate);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!bins.length) return;
    pendingRef.current.push(...bins);
    const maximumPending = 8_192;
    if (pendingRef.current.length > maximumPending) {
      pendingRef.current.splice(0, pendingRef.current.length - maximumPending);
    }
  }, [bins]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
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

    const history: WaveformBin[] = [];
    let width = 0;
    let height = 0;
    let maximumBins = 2_048;
    let frame = 0;
    let lastFrameAt = performance.now();
    let consumeBudget = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(bounds.width * ratio));
      height = Math.max(1, Math.round(bounds.height * ratio));
      maximumBins = Math.max(1_024, Math.round(bounds.width * 3.2));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (history.length > maximumBins) history.splice(0, history.length - maximumBins);
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

    const drawWaveform = () => {
      if (!history.length) return;
      const vertices = new Float32Array(history.length * 4);
      const offset = maximumBins - history.length;
      for (let index = 0; index < history.length; index += 1) {
        const x = -1 + ((offset + index) / Math.max(1, maximumBins - 1)) * 2;
        const [minimum, maximum] = history[index];
        const cursor = index * 4;
        vertices[cursor] = x;
        vertices[cursor + 1] = Math.max(-1, Math.min(1, minimum * 0.92));
        vertices[cursor + 2] = x;
        vertices[cursor + 3] = Math.max(-1, Math.min(1, maximum * 0.92));
      }
      const color: [number, number, number, number] = recordingRef.current
        ? [0.88, 0.36, 0.40, 0.82]
        : [0.35, 0.72, 0.70, 0.78];
      uploadAndDraw(vertices, gl.LINES, color);
    };

    const render = (now: number) => {
      const elapsed = Math.min(34, Math.max(0, now - lastFrameAt));
      lastFrameAt = now;
      const pending = pendingRef.current;
      if (pending.length) {
        // Rust emits one min/max bin per 64 PCM samples. Consuming at that
        // fixed media rate keeps the time axis stable even when IPC batches
        // arrive unevenly.
        consumeBudget += elapsed / 1_000 * Math.max(1, sampleRateRef.current / 64);
        const consume = Math.min(pending.length, Math.floor(consumeBudget));
        if (consume > 0) {
          history.push(...pending.splice(0, consume));
          consumeBudget -= consume;
          if (history.length > maximumBins) history.splice(0, history.length - maximumBins);
        }
      } else {
        consumeBudget = 0;
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawGrid();
      drawWaveform();
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
