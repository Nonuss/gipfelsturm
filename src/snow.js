// Schnee: Material mit Glitzern, Pistenraupen-Rillen und Skispuren aus einem mitwandernden Render-Target.
import * as THREE from 'three';

export const snowUniforms = {
  uTrack: { value: null },
  uTrackCenter: { value: new THREE.Vector2() },
  uTrackSize: { value: 96 },
  uTrackRes: { value: 2048 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
};

const FRAG_HEAD = /* glsl */ `
uniform sampler2D uTrack;
uniform vec2 uTrackCenter;
uniform float uTrackSize;
uniform float uTrackRes;
uniform vec3 uSunDir;
varying vec3 vSnowPos;
varying float vPiste;
varying float vU;
varying float vPow;
varying float vAO;
float snowGlint;

float sHash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 sHash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float sNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(sHash12(i), sHash12(i+vec2(1,0)), f.x), mix(sHash12(i+vec2(0,1)), sHash12(i+vec2(1,1)), f.x), f.y);
}
float snowH(vec2 p, float nearF){
  float h = sNoise(p*0.9)*0.6 + sNoise(p*3.1)*0.25;
  h += sNoise(p*17.0)*0.07*nearF;
  return h;
}
float glintLayer(vec2 p, float scale, vec3 V, vec3 L){
  vec2 g = p*scale; vec2 id = floor(g); vec2 f = fract(g)-0.5;
  vec3 r = sHash32(id);
  vec2 off = (r.xy-0.5)*0.55;
  float dotMask = smoothstep(0.24, 0.06, length(f-off));
  vec3 rn = normalize(r*2.0-1.0 + vec3(0., 0.9, 0.));
  vec3 Hh = normalize(V+L);
  return dotMask * pow(max(dot(rn, Hh), 0.), 70.0);
}
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  vec3 toCam = cameraPosition - vSnowPos;
  float camDist = length(toCam);
  vec3 Vw = toCam / camDist;
  vec2 p = vSnowPos.xz;
  float rockF = smoothstep(0.72, 0.5, Nw.y);
  // Wie viele Meter Boden deckt ein Bildpunkt ab? Details, die kleiner als ein paar Pixel wären, werden ausgeblendet –
  // sonst flimmern sie in der Ferne und das Bild wirkt pixelig (besonders bei niedriger Auflösung am Handy).
  float pxw = max(length(fwidth(p)), 1e-4);
#ifdef LOWQ
  vec2 grad = vec2(0.);
#else
  float fNear = 1.0 - smoothstep(6.0, 40.0, camDist);
  float fMid = 1.0 - smoothstep(80.0, 320.0, camDist);
  float e = 0.05 + camDist*0.004;
  float h0 = snowH(p, fNear), hx = snowH(p+vec2(e,0.), fNear), hz = snowH(p+vec2(0.,e), fNear);
  float rough = mix(1.0, 0.35, vPiste) * (1.0 - rockF) * (1.0 - 0.6*vPow);
  vec2 grad = vec2(hx-h0, hz-h0)/e * 0.11 * fMid * rough * (1.0 - smoothstep(0.06, 0.3, pxw));
#endif

  vec2 tuv = (p - uTrackCenter)/uTrackSize + 0.5;
  vec4 tr = vec4(0.);
  vec2 tgrad = vec2(0.);
  if (tuv.x > 0.003 && tuv.y > 0.003 && tuv.x < 0.997 && tuv.y < 0.997) {
    float tx = 1.3/uTrackRes;
    tr = texture2D(uTrack, tuv);
    tgrad.x = texture2D(uTrack, tuv+vec2(tx,0.)).r - texture2D(uTrack, tuv-vec2(tx,0.)).r;
    tgrad.y = texture2D(uTrack, tuv+vec2(0.,tx)).r - texture2D(uTrack, tuv-vec2(0.,tx)).r;
    vec2 b = min(tuv, 1.0-tuv);
    float fade = smoothstep(0.0, 0.06, min(b.x, b.y));
    tr *= fade; tgrad *= fade;
  }

  // Pistenraupen-Rillen (Cord)
  float ph = vU * (6.2832/0.11);
  float cord = vPiste * (1.0 - smoothstep(0.25, 1.0, fwidth(ph))) * (1.0 - tr.g) * (1.0 - tr.r);
  cord *= 1.0 - rockF;
  grad.x += -sin(ph) * 0.22 * cord;
  // Fels an Klippen: grobe, geschichtete Struktur
  float strata = sNoise(vec2(p.x*0.22, vSnowPos.y*1.7)) * 0.6 + sNoise(vec2(p.x*1.3, vSnowPos.y*4.0 + p.y*0.6)) * 0.4;
  grad += vec2(sNoise(p*2.1 + 7.0) - 0.5, strata - 0.5) * 1.6 * rockF * (1.0 - smoothstep(0.12, 0.6, pxw));
  grad += tgrad * 1.9;

  Nw = normalize(Nw - vec3(grad.x, 0., grad.y));
  normal = normalize((viewMatrix * vec4(Nw, 0.)).xyz);

  // Farbe: zusammengedrückter Schnee in Spuren ist dunkler und blauer
  diffuseColor.rgb *= 0.955 + 0.045*sNoise(p*0.045);
  // Pisten besser erkennbar: präparierte Fläche leicht kühler/matter, am Rand ein weicher dunklerer Saum (aufgeworfener Schnee)
  float edgeBand = smoothstep(0.12, 0.45, vPiste) * (1.0 - smoothstep(0.55, 0.9, vPiste));
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.91, 0.93, 0.97), vPiste*0.8);
  diffuseColor.rgb *= 1.0 - 0.07 * edgeBand * (1.0 - rockF);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.80, 0.86, 0.96), tr.r*0.8);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.90, 0.93, 0.98), tr.g*0.7);
  diffuseColor.rgb *= 1.0 - 0.05*cord*(0.5+0.5*cos(ph));
  // Geländeform und Waldboden als Schattierung (vom Gelände-Mesh vorberechnet): hält Wege und Sprünge auch ohne Schatten lesbar
  diffuseColor.rgb *= min(vAO, 1.04) * mix(vec3(0.80, 0.88, 1.0), vec3(1.0), smoothstep(0.6, 1.0, vAO));
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.975, 0.985, 1.02), vPow * 0.7);

#ifdef LOWQ
  snowGlint = 0.0;
#else
  float g1 = glintLayer(p, 30.0, Vw, uSunDir) * (1.0 - smoothstep(3.0, 20.0, camDist)) * smoothstep(0.012, 0.006, pxw);
  float g2 = glintLayer(p, 9.0, Vw, uSunDir) * (1.0 - smoothstep(12.0, 70.0, camDist)) * smoothstep(1.5, 8.0, camDist) * smoothstep(0.04, 0.02, pxw);
  float g3 = glintLayer(p, 2.6, Vw, uSunDir) * (1.0 - smoothstep(50.0, 190.0, camDist)) * smoothstep(8.0, 40.0, camDist) * 0.7 * smoothstep(0.14, 0.07, pxw);
  snowGlint = (g1 + g2 + g3) * (1.0 - tr.r*0.8) * (1.0 - rockF) * (1.0 + 0.9*vPow);
#endif
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.21, 0.24) * (0.55 + 0.9*strata), rockF);
}
`;

const FRAG_LIGHT = /* glsl */ `
reflectedLight.directSpecular += snowGlint * reflectedLight.directDiffuse * 22.0;
{
  // weiches Streulicht an flachen Blickwinkeln
  vec3 Vv = normalize(vViewPosition);
  float fr = pow(1.0 - max(dot(normal, Vv), 0.0), 4.0);
  reflectedLight.indirectDiffuse += vec3(0.55, 0.68, 0.9) * fr * 0.10;
}
`;

export function makeSnowMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  if (opts.patch) {
    mat.defines = { PATCH: 1 };
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, snowUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPiste;
#ifdef PATCH
attribute float aLayer;
uniform sampler2D uTrack;
uniform vec2 uTrackCenter;
uniform float uTrackSize;
#endif
attribute float aU;
attribute float aPow;
attribute float aAO;
varying vec3 vSnowPos;
varying float vPiste;
varying float vU;
varying float vPow;
varying float vAO;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef PATCH
{
  // Pulverschicht: wo Spuren liegen, ist der Schnee weggeschoben (Rinne), sonst steht er bis zu 30 cm hoch
  vec2 tuvP = (position.xz - uTrackCenter) / uTrackSize + 0.5;
  float trD = texture2D(uTrack, tuvP).r;
  transformed.y += aLayer * (1.0 - smoothstep(0.08, 0.5, trD));
}
#endif
vSnowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vPiste = aPiste;
vU = aU;
vPow = aPow;
vAO = aAO;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + FRAG_LIGHT);
  };
  mat.customProgramCacheKey = () => 'snow-v4-' + (opts.patch ? 'patch' : 'main') + (mat.defines && mat.defines.LOWQ ? 'low' : 'hi');
  return mat;
}

// ---------------------------------------------------------------- Spuren-Textur
export class SnowTracks {
  constructor(renderer, size = 96, res = 2048) {
    this.renderer = renderer;
    this.size = size;
    this.res = res;
    const opts = {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.a = new THREE.WebGLRenderTarget(res, res, opts);
    this.b = new THREE.WebGLRenderTarget(res, res, opts);
    this.center = new THREE.Vector2(0, 0);
    this.cam = new THREE.Camera();
    this.needClear = true;

    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tPrev: { value: null }, uOffset: { value: new THREE.Vector2() }, uKeep: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: `uniform sampler2D tPrev; uniform vec2 uOffset; uniform float uKeep; varying vec2 vUv;
        void main(){ vec2 uv = vUv + uOffset;
          vec4 c = (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) ? vec4(0.) : texture2D(tPrev, uv);
          gl_FragColor = c * uKeep; }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.copyScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    quad.frustumCulled = false;
    this.copyScene.add(quad);

    this.maxQuads = 160;
    this.pos = new Float32Array(this.maxQuads * 6 * 3);
    this.val = new Float32Array(this.maxQuads * 6 * 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aVal', new THREE.BufferAttribute(this.val, 2).setUsage(THREE.DynamicDrawUsage));
    this.count = 0;
    this.stampMat = new THREE.ShaderMaterial({
      uniforms: { uCenter: { value: new THREE.Vector2() }, uSize: { value: size } },
      vertexShader: `attribute vec2 aVal; uniform vec2 uCenter; uniform float uSize; varying vec2 vVal; varying float vEdge;
        void main(){ vVal = aVal; vEdge = position.z; gl_Position = vec4((position.xy - uCenter)/uSize*2.0, 0., 1.); }`,
      fragmentShader: `varying vec2 vVal; varying float vEdge;
        void main(){ float s = smoothstep(1.0, 0.35, abs(vEdge)); gl_FragColor = vec4(vVal*s, 0., 1.); }`,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.stampScene = new THREE.Scene();
    const m = new THREE.Mesh(this.geo, this.stampMat);
    m.frustumCulled = false;
    this.stampScene.add(m);
    snowUniforms.uTrackSize.value = size;
    snowUniforms.uTrackRes.value = res;
  }

  /** Viereck in Weltkoordinaten (x,z), e0..e3 = Randkoordinate für weichen Rand, r = Rillentiefe, g = abgeschabt. */
  quad(x0, z0, e0, x1, z1, e1, x2, z2, e2, x3, z3, e3, r, g) {
    if (this.count >= this.maxQuads) return;
    const p = this.pos, v = this.val;
    let i = this.count * 18, j = this.count * 12;
    const put = (x, z, e) => { p[i++] = x; p[i++] = z; p[i++] = e; v[j++] = r; v[j++] = g; };
    put(x0, z0, e0); put(x1, z1, e1); put(x2, z2, e2);
    put(x0, z0, e0); put(x2, z2, e2); put(x3, z3, e3);
    this.count++;
  }

  /** Runder Abdruck (z. B. Sturz, Landung). */
  blob(x, z, rad, r, g) {
    this.quad(x - rad, z - rad, 0.6, x + rad, z - rad, 0.6, x + rad, z + rad, 0.6, x - rad, z + rad, 0.6, r, g);
  }

  clear() { this.needClear = true; }

  update(px, pz) {
    const r = this.renderer;
    const texel = this.size / this.res;
    const nx = Math.round(px / texel) * texel, nz = Math.round(pz / texel) * texel;
    this.copyMat.uniforms.tPrev.value = this.a.texture;
    this.copyMat.uniforms.uOffset.value.set((nx - this.center.x) / this.size, (nz - this.center.y) / this.size);
    this.copyMat.uniforms.uKeep.value = this.needClear ? 0 : 1;
    this.needClear = false;
    this.center.set(nx, nz);
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.b);
    r.render(this.copyScene, this.cam);
    if (this.count > 0) {
      this.stampMat.uniforms.uCenter.value.set(nx, nz);
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aVal.needsUpdate = true;
      this.geo.setDrawRange(0, this.count * 6);
      r.render(this.stampScene, this.cam);
      this.count = 0;
    }
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    const t = this.a; this.a = this.b; this.b = t;
    snowUniforms.uTrack.value = this.a.texture;
    snowUniforms.uTrackCenter.value.set(nx, nz);
  }
}
