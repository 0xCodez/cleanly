import { useEffect, useRef } from 'react';

// "Cosmic wind": domain-warped fbm smoke rendered with WebGL.
// mode 'plume' rises from the bottom of a card; mode 'mist' is the slow silk background.
const FRAG = `
precision highp float;
uniform vec2 r; uniform float t; uniform float energy; uniform float mode;
uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform vec3 c4;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = m * p; a *= 0.5; } return v; }
vec3 paint(vec2 w, float q, float f){
  vec3 col = mix(c1, c2, smoothstep(0.2, 0.8, w.x));
  col = mix(col, c3, smoothstep(0.3, 0.9, q));
  return mix(col, c4, smoothstep(0.55, 0.95, f));
}
void main(){
  vec2 uv = gl_FragCoord.xy / r;
  float dither = (hash(gl_FragCoord.xy + t) - 0.5) / 255.0;
  if (mode < 0.5) {
    vec2 p = vec2(uv.x * r.x / r.y, uv.y) * 2.3;
    float T = t * 0.12;
    vec2 q = vec2(fbm(p + vec2(0.0, -T * 2.0)), fbm(p + vec2(5.2, 1.3 - T * 2.0)));
    vec2 w = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) - vec2(0.0, T * 3.0)), fbm(p + 3.0 * q + vec2(8.3, 2.8) - vec2(0.0, T * 2.5)));
    float f = fbm(p + 2.6 * w);
    float h = uv.y - (f - 0.5) * 0.65 - 0.06 * sin(p.x * 1.4 + T * 5.0);
    float mask = smoothstep(0.62, 0.0, h) * (0.45 + 0.55 * smoothstep(0.05, 0.75, uv.x));
    float a = clamp(mask * energy * (0.35 + 0.6 * f) + dither, 0.0, 0.92);
    gl_FragColor = vec4(paint(w, q.y, f) * a, a);
  } else {
    vec2 p = vec2(uv.x * r.x / r.y, uv.y) * 1.6;
    float T = t * 0.05;
    vec2 q = vec2(fbm(p * 0.9 + vec2(-T * 1.5, T * 0.3)), fbm(p * 0.9 + vec2(4.1, 2.7) - vec2(T * 1.2, 0.0)));
    vec2 w = vec2(fbm(p + 2.2 * q + vec2(1.3, 7.1) + T * 0.4), fbm(p + 2.2 * q + vec2(6.7, 3.3) - T * 0.35));
    float f = fbm(p + 2.0 * w - vec2(T * 2.0, 0.0));
    float bands = sin(p.y * 3.0 + f * 7.0 + w.x * 4.0 - T * 6.0);
    float bands2 = sin(p.y * 5.5 - f * 5.0 + q.x * 6.0 + T * 4.0);
    float ribbon = smoothstep(0.5, 1.0, bands) * 0.85 + smoothstep(0.7, 1.0, bands2) * 0.45 + smoothstep(0.0, 1.0, bands) * 0.2;
    float g = fract(t / 14.0);
    float gx = mix(-0.5, 1.6, g);
    float gust = exp(-pow((uv.x - gx + (f - 0.5) * 0.5 + (uv.y - 0.5) * 0.25) * 3.2, 2.0)) * smoothstep(0.0, 0.12, g) * smoothstep(1.0, 0.82, g);
    vec2 c = uv - 0.5;
    float vig = smoothstep(0.12, 0.78, length(c * vec2(1.0, 1.35)));
    float mask = (0.16 + 0.6 * ribbon + 0.45 * gust) * (0.4 + 0.6 * vig) * (0.55 + 0.6 * f);
    vec3 col = mix(paint(w, ribbon, f), vec3(1.0), gust * 0.35);
    float a = clamp(mask * energy + dither, 0.0, 0.9);
    gl_FragColor = vec4(col * a, a);
  }
}`;

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const PLUME = ['#ffa8c4', '#ffd2a1', '#a9d6ff', '#cbb9ff'].map(hex);
const CALM = ['#8fefc9', '#a8dcff', '#d4f6ff', '#b9f0e0'].map(hex);
const MOODS = [
  ['#ffb8cf', '#ffd9b0', '#c9d8ff', '#e6c8ff'],
  ['#a9d2ff', '#c9bcff', '#ffc6dd', '#e4f1ff'],
  ['#a8f0dc', '#b5dcff', '#ffd6c2', '#d9cfff'],
  ['#ffc2b0', '#d6b8ff', '#ffb8d6', '#ffe6c4'],
].map((m) => m.map(hex));

interface FlowProps {
  mode: 'plume' | 'mist';
  /** plume only: switch to the calm mint palette (after a clean) */
  calm?: boolean;
  /** bump this number to send a gust through the plume */
  pulse?: number;
  className?: string;
}

export function Flow({ mode, calm = false, pulse = 0, className }: FlowProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ calm, boost: 0 });
  live.current.calm = calm;

  useEffect(() => {
    if (pulse) live.current.boost = 1;
  }, [pulse]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl || gl.isContextLost()) return;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (k: string) => gl.getUniformLocation(prog, k);
    const U = { r: u('r'), t: u('t'), energy: u('energy'), mode: u('mode'), c: [u('c1'), u('c2'), u('c3'), u('c4')] };

    // internal resolution: the smoke is soft, so a fraction of the CSS size is plenty
    const scale = mode === 'mist' ? 0.32 : 0.5;
    const resize = () => {
      canvas.width = Math.max(2, Math.round(canvas.clientWidth * scale));
      canvas.height = Math.max(2, Math.round(canvas.clientHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const colors = (mode === 'mist' ? MOODS[0] : PLUME).map((c) => [...c] as RGB);
    let clock = mode === 'mist' ? 50 : 20;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      // real elapsed time, so a slow machine gets fewer frames rather than slower motion
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const st = live.current;
      const speed = reduce ? 0.15 : mode === 'mist' ? 1 : 1 + st.boost * 3;
      st.boost = Math.max(0, st.boost - dt * 0.8);
      clock += dt * speed;

      const target = mode === 'mist' ? MOODS[Math.floor(clock / 18) % MOODS.length] : st.calm ? CALM : PLUME;
      const ease = mode === 'mist' ? 1 - Math.exp(-dt / 5) : 1 - Math.exp(-dt * 2);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) colors[i][j] += (target[i][j] - colors[i][j]) * ease;

      gl.uniform2f(U.r, canvas.width, canvas.height);
      gl.uniform1f(U.t, clock);
      gl.uniform1f(U.energy, mode === 'mist' ? 1.4 : 1.15 + st.boost * 0.25);
      gl.uniform1f(U.mode, mode === 'mist' ? 1 : 0);
      U.c.forEach((loc, i) => gl.uniform3fv(loc, colors[i]));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      // free the GPU context only when the canvas is really gone; StrictMode re-runs effects on the same canvas
      setTimeout(() => {
        if (!canvas.isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext();
      }, 0);
    };
  }, [mode]);

  return <canvas ref={ref} className={className} aria-hidden="true" style={{ width: '100%', height: '100%', display: 'block' }} />;
}
