import * as THREE from "three";
import { createGroundColorTexture, createGroundNormalTexture } from "./graphics";

export const ARENA_RADIUS = 90;
const TERRAIN_SIZE = 184;
const TERRAIN_SEGMENTS = 8;
const HEIGHT_CACHE_STEP = 2;
const heightCache = new Map<number, number>();

function heightCacheKey(x: number, z: number): number {
  const qx = Math.round(x / HEIGHT_CACHE_STEP);
  const qz = Math.round(z / HEIGHT_CACHE_STEP);
  return qx * 73856093 ^ qz * 19349663;
}

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
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(n00, n10, sx),
    THREE.MathUtils.lerp(n01, n11, sx),
    sz,
  );
}

function fbm(x: number, z: number): number {
  return noise2(x * 0.045, z * 0.045) * 0.65 + noise2(x * 0.09, z * 0.09) * 0.35;
}

export function sampleTerrainHeight(x: number, z: number): number {
  const key = heightCacheKey(x, z);
  const cached = heightCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const dist = Math.hypot(x, z);
  if (dist > ARENA_RADIUS + 2) {
    return -2.5;
  }

  let height = fbm(x, z) * 2.2 + Math.pow(Math.max(0, 1 - dist / ARENA_RADIUS), 1.35) * 0.35;
  height *= THREE.MathUtils.lerp(0.35, 1, THREE.MathUtils.smoothstep(dist, 8, 26));
  height *= THREE.MathUtils.smoothstep(ARENA_RADIUS, ARENA_RADIUS - 10, dist);

  const result = Math.max(0, height);
  heightCache.set(key, result);
  return result;
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
  const grassLow = new THREE.Color(0x3f6f3e);
  const grassHigh = new THREE.Color(0x5f8f52);
  const path = new THREE.Color(0xc4aa7a);
  const rock = new THREE.Color(0x6a7268);

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const height = sampleTerrainHeight(x, z);
    positions.setY(index, height);

    const dist = Math.hypot(x, z);
    const pathMask =
      THREE.MathUtils.smoothstep(dist, 5, 18) *
      (1 - THREE.MathUtils.smoothstep(dist, 18, 32));
    const heightBlend = THREE.MathUtils.clamp(height / 2.4, 0, 1);

    color.copy(grassLow).lerp(grassHigh, heightBlend);
    color.lerp(path, pathMask * 0.85);
    color.lerp(rock, heightBlend * 0.22);

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
    map: createGroundColorTexture(),
    normalMap: createGroundNormalTexture(),
    normalScale: new THREE.Vector2(0.42, 0.42),
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.04,
    envMapIntensity: 0.55,
  });

  const mesh = new THREE.Mesh(buildTerrainGeometry(), material);
  mesh.receiveShadow = true;

  return {
    mesh,
    radius: ARENA_RADIUS,
  };
}
