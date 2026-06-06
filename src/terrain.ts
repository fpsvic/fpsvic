import * as THREE from "three";
import { createTerrainSplatMaterial } from "./terrainMaterial";
import { getTerrainTextures } from "./terrainTextures";

export const ARENA_RADIUS = 128;
const TERRAIN_SIZE = 268;
const TERRAIN_SEGMENTS = 128;
export const STORM_START_RADIUS = 112;
export const STORM_MIN_RADIUS = 32;
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
  return (
    noise2(x * 0.045, z * 0.045) * 0.55 +
    noise2(x * 0.09, z * 0.09) * 0.28 +
    noise2(x * 0.18, z * 0.18) * 0.17
  );
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

  let height = fbm(x, z) * 2.35 + Math.pow(Math.max(0, 1 - dist / ARENA_RADIUS), 1.35) * 0.38;
  height += noise2(x * 0.22, z * 0.22) * 0.12;
  height *= THREE.MathUtils.lerp(0.35, 1, THREE.MathUtils.smoothstep(dist, 8, 26));
  height *= THREE.MathUtils.smoothstep(ARENA_RADIUS, ARENA_RADIUS - 10, dist);

  const result = Math.max(0, height);
  heightCache.set(key, result);
  return result;
}

function sampleSlope(x: number, z: number): number {
  const delta = 1.4;
  const hL = sampleTerrainHeight(x - delta, z);
  const hR = sampleTerrainHeight(x + delta, z);
  const hD = sampleTerrainHeight(x, z - delta);
  const hU = sampleTerrainHeight(x, z + delta);
  return Math.hypot(hR - hL, hU - hD) / (delta * 2);
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

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const height = sampleTerrainHeight(x, z);
    positions.setY(index, height);

    const dist = Math.hypot(x, z);
    const pathMask =
      THREE.MathUtils.smoothstep(dist, 4, 16) *
      (1 - THREE.MathUtils.smoothstep(dist, 16, 34));
    const slope = sampleSlope(x, z);
    const heightNorm = THREE.MathUtils.clamp(height / 2.5, 0, 1);
    const rockMask =
      THREE.MathUtils.smoothstep(heightNorm, 0.42, 0.88) *
      THREE.MathUtils.smoothstep(slope, 0.14, 0.52);
    const wetLow = (1 - heightNorm) * THREE.MathUtils.smoothstep(dist, 12, 42) * 0.12;

    let grassWeight = (1 - pathMask) * (1 - rockMask * 0.92) + wetLow;
    let dirtWeight = pathMask * 0.92 + wetLow * 0.35;
    let rockWeight = rockMask * 0.95;

    const weightSum = grassWeight + dirtWeight + rockWeight;
    grassWeight /= weightSum;
    dirtWeight /= weightSum;
    rockWeight /= weightSum;

    colors[index * 3] = grassWeight;
    colors[index * 3 + 1] = dirtWeight;
    colors[index * 3 + 2] = rockWeight;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.attributes.position.needsUpdate = true;
  return geometry;
}

export type ArenaTerrain = {
  mesh: THREE.Mesh;
  radius: number;
};

export function createArenaTerrain(): ArenaTerrain {
  const textures = getTerrainTextures();
  const material = createTerrainSplatMaterial(textures);

  const mesh = new THREE.Mesh(buildTerrainGeometry(), material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return {
    mesh,
    radius: ARENA_RADIUS,
  };
}
