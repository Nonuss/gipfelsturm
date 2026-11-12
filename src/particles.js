// Schneestaub (Gischt an den Kanten) und schwebende Eiskristalle in der Luft.
import * as THREE from 'three';

export class Spray {
  constructor(scene, max = 9000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.data = new Float32Array(max * 3); // Größe, Alpha, Wachstum
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.alp = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aData', new THREE.BufferAttribute(this.data, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uFocus: { value: new THREE.Vector3() } },
      vertexShader: `attribute vec3 aData; varying float vA; uniform float uScale; uniform vec3 uFocus;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = -mv.z;
          // Wolken nahe an der Kamera werden durchsichtig, damit der Fahrer bei Stürzen sichtbar bleibt
          vA = aData.y * mix(0.3, 1.0, smoothstep(2.0, 8.0, dist));
          // große Wolken werden nahe am Fahrer durchsichtig: die Figur bleibt auch bei Sturz und im Pulver sichtbar
          vA *= mix(1.0, mix(0.55, 1.0, smoothstep(1.5, 5.5, length(position - uFocus))), aData.z);
          gl_PointSize = aData.x * uScale / max(0.1, dist); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA;
        void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q);
          float a = smoothstep(0.5, 0.05, d) * vA; if (a < 0.004) discard;
          vec3 col = mix(vec3(0.78, 0.86, 1.0), vec3(1.0), smoothstep(0.25, -0.35, q.y) * 0.8 + 0.2);
          gl_FragColor = vec4(col * 0.98, a); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  /** grav: Fallbeschleunigung, alpha: Deckkraft, grow: wie stark die Wolke aufquillt */
  emit(x, y, z, vx, vy, vz, size, life, grav = 5.5, alpha = 0.55, grow = 2.2) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size0[i] = size;
    this.grav[i] = grav; this.alp[i] = alpha; this.grow[i] = grow;
  }

  update(dt) {
    const { pos, vel, life, maxLife, data, size0, grav, alp, grow } = this;
    const drag = Math.exp(-dt * 2.2);
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) { if (data[i * 3 + 1] !== 0) { data[i * 3] = 0; data[i * 3 + 1] = 0; } continue; }
      life[i] -= dt;
      const j = i * 3;
      vel[j] *= drag; vel[j + 1] = vel[j + 1] * drag - grav[i] * dt; vel[j + 2] *= drag;
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      const t = Math.max(0, life[i] / maxLife[i]);
      data[j] = size0[i] * (1 + (1 - t) * grow[i]);
      data[j + 1] = t * t * alp[i] * Math.min(1, (1 - t) * 12);
      data[j + 2] = grow[i] > 2.3 ? 1 : 0;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aData.needsUpdate = true;
  }

  setFocus(p) { this.mat.uniforms.uFocus.value.copy(p); }

  resize(h, fov) {
    this.mat.uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }
}

export class DiamondDust {
  constructor(scene, count = 1400) {
    const p = new Float32Array(count * 3), r = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      p[i * 3] = Math.random(); p[i * 3 + 1] = Math.random(); p[i * 3 + 2] = Math.random();
      r[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aRnd', new THREE.BufferAttribute(r, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uScale: { value: 600 } },
      vertexShader: `attribute float aRnd; uniform float uTime; uniform vec3 uCam; uniform float uScale; varying float vA;
        void main(){
          vec3 box = vec3(60., 26., 60.);
          vec3 w = position * box + vec3(uTime*1.3 + sin(uTime*0.7 + aRnd*40.)*0.6, -uTime*(0.5 + aRnd*0.6), uTime*0.4);
          w = mod(w - uCam, box) - box*0.5 + uCam;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          float dist = -mv.z;
          float tw = pow(0.5 + 0.5*sin(uTime*(3. + aRnd*9.) + aRnd*100.), 6.0);
          vA = (0.18 + 0.82*tw) * smoothstep(30., 18., dist) * smoothstep(0.6, 3.0, dist);
          gl_PointSize = (0.035 + 0.05*aRnd) * uScale / max(0.3, dist);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vA; if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(1.6, 1.65, 1.8), a); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
  }
  update(time, cam) {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uCam.value.copy(cam.position);
  }
  resize(h, fov) {
    this.mat.uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }
}
