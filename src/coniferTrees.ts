import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";

const TEXTURE_SIZE = 256;

type BarkMaps = {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
};

type NeedleMaps = {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
};

let barkMaps: BarkMaps | null = null;
let needleMaps: NeedleMaps | null = null;
let trunkGeometry: THREE.BufferGeometry | null = null;
let foliageGeometry: THREE.BufferGeometry | null = null;
let trunkMaterial: THREE.MeshStandardMaterial | null = null;
let foliageMaterial: THREE.MeshStandardMaterial | null = null;

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create conifer texture canvas.");
  }
  return { canvas, ctx };
}

function toTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = colorSpace;
  return texture;
}

function createBarkMaps(): BarkMaps {
  const { canvas, ctx } = makeCanvas(TEXTURE_SIZE);
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const grain =
        Math.sin(u * 48 + v * 6) * 0.22 +
        Math.sin(u * 112 - v * 18) * 0.14 +
        Math.sin(v * 220 + u * 8) * 0.08;
      const furrow = Math.sin(v * 420 + Math.sin(u * 30) * 2.5) * 0.12;
      const knot = Math.hypot(u - 0.72, v - 0.35) < 0.06 ? -0.18 : 0;
      const base = 58 + grain * 28 + furrow * 22 + knot * 40;
      const index = (y * TEXTURE_SIZE + x) * 4;
      image.data[index] = Math.min(255, base + 12);
      image.data[index + 1] = Math.min(255, base - 6);
      image.data[index + 2] = Math.min(255, base - 22);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(TEXTURE_SIZE);
  const normalImage = normalCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const bump =
        Math.sin(u * 96 + v * 12) * 0.35 +
        Math.sin(v * 180 + u * 22) * 0.22;
      const index = (y * TEXTURE_SIZE + x) * 4;
      normalImage.data[index] = Math.floor(128 + bump * 24);
      normalImage.data[index + 1] = Math.floor(128 + bump * 8);
      normalImage.data[index + 2] = Math.floor(248 + bump * 6);
      normalImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);

  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(TEXTURE_SIZE);
  const roughImage = roughCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const rough =
        0.72 +
        Math.sin(u * 80 + v * 14) * 0.12 +
        Math.sin(v * 160) * 0.08;
      const index = (y * TEXTURE_SIZE + x) * 4;
      const value = Math.floor(rough * 255);
      roughImage.data[index] = value;
      roughImage.data[index + 1] = value;
      roughImage.data[index + 2] = value;
      roughImage.data[index + 3] = 255;
    }
  }
  roughCtx.putImageData(roughImage, 0, 0);

  return {
    map: toTexture(canvas),
    normalMap: toTexture(normalCanvas, THREE.LinearSRGBColorSpace),
    roughnessMap: toTexture(roughCanvas, THREE.LinearSRGBColorSpace),
  };
}

function createNeedleMaps(): NeedleMaps {
  const { canvas, ctx } = makeCanvas(TEXTURE_SIZE);
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const needleField =
        Math.sin(u * 180 + v * 140) * Math.cos(v * 210 - u * 120);
      const cluster =
        Math.sin(u * 34 + v * 29) * 0.5 +
        Math.sin(u * 71 - v * 53) * 0.28 +
        Math.sin(u * 143 + v * 97) * 0.14;
      const tip = Math.max(0, needleField) * 0.35;
      const shadow = cluster < -0.25 ? 0.18 : 0;
      const sun = Math.pow(Math.max(0, 1 - v * 0.85), 1.4) * 0.22;

      const r = 18 + cluster * 22 + tip * 28 + sun * 18 - shadow * 8;
      const g = 58 + cluster * 48 + tip * 42 + sun * 32 - shadow * 12;
      const b = 16 + cluster * 14 + tip * 10 + sun * 6 - shadow * 6;

      const index = (y * TEXTURE_SIZE + x) * 4;
      image.data[index] = Math.min(255, Math.max(0, r));
      image.data[index + 1] = Math.min(255, Math.max(0, g));
      image.data[index + 2] = Math.min(255, Math.max(0, b));
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(TEXTURE_SIZE);
  const normalImage = normalCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const bump =
        Math.sin(u * 220 + v * 180) * 0.42 +
        Math.sin(u * 420 - v * 300) * 0.18;
      const index = (y * TEXTURE_SIZE + x) * 4;
      normalImage.data[index] = Math.floor(128 + bump * 18);
      normalImage.data[index + 1] = Math.floor(128 + bump * 18);
      normalImage.data[index + 2] = Math.floor(248 + bump * 8);
      normalImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);

  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(TEXTURE_SIZE);
  const roughImage = roughCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const rough = 0.78 + Math.sin(u * 140 + v * 120) * 0.14;
      const index = (y * TEXTURE_SIZE + x) * 4;
      const value = Math.floor(rough * 255);
      roughImage.data[index] = value;
      roughImage.data[index + 1] = value;
      roughImage.data[index + 2] = value;
      roughImage.data[index + 3] = 255;
    }
  }
  roughCtx.putImageData(roughImage, 0, 0);

  return {
    map: toTexture(canvas),
    normalMap: toTexture(normalCanvas, THREE.LinearSRGBColorSpace),
    roughnessMap: toTexture(roughCanvas, THREE.LinearSRGBColorSpace),
  };
}

function buildTrunkGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.15, 0.24, 1.4, 10, 4);
  geometry.translate(0, 0.7, 0);
  return geometry;
}

function buildFoliageGeometry(): THREE.BufferGeometry {
  const tiers = [
    { radius: 1.18, height: 1.45, y: 1.18, segments: 9 },
    { radius: 0.96, height: 1.28, y: 2.12, segments: 9 },
    { radius: 0.72, height: 1.12, y: 2.88, segments: 8 },
    { radius: 0.48, height: 0.82, y: 3.48, segments: 7 },
  ];

  const parts = tiers.map((tier) => {
    const cone = new THREE.ConeGeometry(tier.radius, tier.height, tier.segments);
    cone.translate(0, tier.y, 0);
    return cone;
  });

  const merged = mergeGeometries(parts);
  if (!merged) {
    throw new Error("Unable to merge conifer foliage geometry.");
  }
  merged.computeVertexNormals();
  return merged;
}

export function getConiferTrunkGeometry(): THREE.BufferGeometry {
  trunkGeometry ??= buildTrunkGeometry();
  return trunkGeometry;
}

export function getConiferFoliageGeometry(): THREE.BufferGeometry {
  foliageGeometry ??= buildFoliageGeometry();
  return foliageGeometry;
}

export function getConiferTrunkMaterial(): THREE.MeshStandardMaterial {
  if (trunkMaterial) {
    return trunkMaterial;
  }
  barkMaps ??= createBarkMaps();
  barkMaps.map.repeat.set(1.2, 2.4);
  barkMaps.normalMap.repeat.set(1.2, 2.4);
  barkMaps.roughnessMap.repeat.set(1.2, 2.4);

  trunkMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: barkMaps.map,
    normalMap: barkMaps.normalMap,
    normalScale: new THREE.Vector2(0.85, 1.1),
    roughnessMap: barkMaps.roughnessMap,
    roughness: 1,
    metalness: 0.02,
    envMapIntensity: 0.62,
  });
  return trunkMaterial;
}

export function getConiferFoliageMaterial(): THREE.MeshStandardMaterial {
  if (foliageMaterial) {
    return foliageMaterial;
  }
  needleMaps ??= createNeedleMaps();
  needleMaps.map.repeat.set(2.4, 2.4);
  needleMaps.normalMap.repeat.set(2.4, 2.4);
  needleMaps.roughnessMap.repeat.set(2.4, 2.4);

  foliageMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: needleMaps.map,
    normalMap: needleMaps.normalMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    roughnessMap: needleMaps.roughnessMap,
    roughness: 1,
    metalness: 0,
    emissive: new THREE.Color(0x0c2010),
    emissiveIntensity: 0.08,
    envMapIntensity: 0.82,
  });
  return foliageMaterial;
}

export function applyConiferTextureAnisotropy(renderer: THREE.WebGLRenderer): void {
  const max = renderer.capabilities.getMaxAnisotropy();
  barkMaps ??= createBarkMaps();
  needleMaps ??= createNeedleMaps();
  for (const texture of [
    barkMaps.map,
    barkMaps.normalMap,
    barkMaps.roughnessMap,
    needleMaps.map,
    needleMaps.normalMap,
    needleMaps.roughnessMap,
  ]) {
    texture.anisotropy = Math.min(8, max);
  }
}

export type ConiferPlacement = {
  x: number;
  z: number;
  scale: number;
  yaw: number;
  groundY: number;
};

const placementDummy = new THREE.Object3D();

export function placeConiferInstances(
  trunks: THREE.InstancedMesh,
  foliage: THREE.InstancedMesh,
  placements: ConiferPlacement[],
): void {
  for (let index = 0; index < placements.length; index += 1) {
    const tree = placements[index];
    const { x, z, scale, yaw, groundY } = tree;

    placementDummy.position.set(x, groundY + 0.02, z);
    placementDummy.rotation.set(0, yaw, 0);
    placementDummy.scale.set(scale, scale, scale);
    placementDummy.updateMatrix();
    trunks.setMatrixAt(index, placementDummy.matrix);

    placementDummy.position.set(x, groundY + 0.02, z);
    placementDummy.updateMatrix();
    foliage.setMatrixAt(index, placementDummy.matrix);
  }

  trunks.count = placements.length;
  foliage.count = placements.length;
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
}

export function sampleArenaTreeGroundY(x: number, z: number): number {
  const dist = Math.hypot(x, z);
  if (dist <= ARENA_RADIUS + 1) {
    return sampleTerrainHeight(x, z);
  }
  return -0.15 + (Math.sin(x * 0.17 + z * 0.23) * 43758.5453 % 1) * 0.35;
}
