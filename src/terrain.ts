import * as THREE from "three";

const ARENA_RADIUS = 90;
const TERRAIN_SIZE = 184;
const TERRAIN_SEGMENTS = 36;

function hash2(x: number, z: number): number {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function noise2(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;
  const sx = x - x0;
  const sz = z - z0;
  const n00 = hash2(x0, z0);
  const n10 = hash2(x1, z0);
  const n01 = hash2(x0, z1);
  const n11 = hash2(x1, z1);
  const ix0 = THREE.MathUtils.lerp(n00, n10, sx);
  const ix1 = THREE.MathUtils.lerp(n01, n11, sx);
  return THREE.MathUtils.lerp(ix0, ix1, sz);
}

function fbm(x: number, z: number): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 0.045;
  for (let octave = 0; octave < 4; octave += 1) {
    sum += noise2(x * freq, z * freq) * amp;
    freq *= 2.05;
    amp *= 0.5;
  }
  return sum;
}

export function sampleTerrainHeight(x: number, z: number): number {
  const dist = Math.hypot(x, z);
  if (dist > ARENA_RADIUS + 2) {
    return -2.5;
  }

  const macro = fbm(x, z);
  const detail = noise2(x * 0.22, z * 0.22) * 0.22;
  const ridge = Math.pow(Math.max(0, 1 - dist / ARENA_RADIUS), 1.35) * 1.1;
  let height = macro * 2.4 + detail + ridge * 0.35;

  const centerBlend = THREE.MathUtils.smoothstep(dist, 8, 26);
  height *= THREE.MathUtils.lerp(0.35, 1, centerBlend);

  const edgeFalloff = THREE.MathUtils.smoothstep(ARENA_RADIUS, ARENA_RADIUS - 10, dist);
  height *= edgeFalloff;

  return Math.max(0, height);
}

function buildTerrainGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    TERRAIN_SEGMENTS,
    TERRAIN_SEGMENTS,
  );
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const color = new THREE.Color();

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const height = sampleTerrainHeight(x, z);
    positions.setY(index, height);

    const dist = Math.hypot(x, z);
    const slope = Math.min(1, Math.abs(height - sampleTerrainHeight(x + 1.2, z)) * 0.9);
    const grass = new THREE.Color(0x3f6b42).lerp(new THREE.Color(0x5f8f52), height * 0.35);
    const dirt = new THREE.Color(0x8a7355).lerp(new THREE.Color(0x6f5a42), slope);
    const path = new THREE.Color(0xb39a72);
    const pathMask = THREE.MathUtils.smoothstep(dist, 4, 20) * (1 - THREE.MathUtils.smoothstep(dist, 20, 34));
    const dirtMask = THREE.MathUtils.clamp(slope * 1.6 + height * 0.12, 0, 1);

    color.copy(grass);
    color.lerp(dirt, dirtMask);
    color.lerp(path, pathMask * 0.85);

    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export type ArenaTerrain = {
  mesh: THREE.Mesh;
  radius: number;
};

export function createArenaTerrain(): ArenaTerrain {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.02,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(buildTerrainGeometry(), material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return { mesh, radius: ARENA_RADIUS };
}
