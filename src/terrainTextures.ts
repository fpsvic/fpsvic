import * as THREE from "three";

export type SurfaceTextureMaps = {
  color: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
  ao: THREE.CanvasTexture;
};

export type TerrainTextureSet = {
  grass: SurfaceTextureMaps;
  dirt: SurfaceTextureMaps;
  rock: SurfaceTextureMaps;
};

const TEXTURE_SIZE = 512;

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create terrain texture canvas.");
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

function fillGrassColor(image: ImageData, size: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const patch =
        Math.sin(u * 18 + v * 11) * 0.5 +
        Math.sin(u * 43 - v * 29) * 0.28 +
        Math.sin(u * 97 + v * 61) * 0.14;
      const blade = Math.sin(u * 220 + v * 180) * Math.cos(v * 210 - u * 140);
      const dry = Math.sin(u * 7.2 + v * 5.8) > 0.62 ? 1 : 0;
      const moss = Math.sin(u * 31 + v * 37) > 0.78 ? 1 : 0;

      const lushG = 88 + patch * 42 + blade * 12;
      const lushR = 42 + patch * 26 + dry * 22 + moss * 10;
      const lushB = 28 + patch * 16 + dry * 5;

      const index = (y * size + x) * 4;
      image.data[index] = Math.min(255, lushR);
      image.data[index + 1] = Math.min(255, lushG);
      image.data[index + 2] = Math.min(255, lushB);
      image.data[index + 3] = 255;
    }
  }
}

function fillDirtColor(image: ImageData, size: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const grain =
        Math.sin(u * 64 + v * 48) * 0.35 +
        Math.sin(u * 128 - v * 96) * 0.22;
      const pebble = Math.sin(u * 210 + v * 190) > 0.72 ? 0.18 : 0;
      const crack = Math.abs(Math.sin(u * 12 + v * 9)) < 0.08 ? -0.12 : 0;

      const index = (y * size + x) * 4;
      image.data[index] = Math.floor(118 + grain * 28 + pebble * 35 + crack * 40);
      image.data[index + 1] = Math.floor(88 + grain * 22 + pebble * 28 + crack * 30);
      image.data[index + 2] = Math.floor(58 + grain * 16 + pebble * 18);
      image.data[index + 3] = 255;
    }
  }
}

function fillRockColor(image: ImageData, size: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const stone =
        Math.sin(u * 38 + v * 44) * 0.4 +
        Math.sin(u * 82 - v * 71) * 0.25 +
        Math.sin(u * 156 + v * 132) * 0.12;
      const moss = Math.sin(u * 24 + v * 28) > 0.55 ? 1 : 0;

      const index = (y * size + x) * 4;
      const base = 98 + stone * 32;
      image.data[index] = Math.floor(base - moss * 18);
      image.data[index + 1] = Math.floor(base + moss * 22);
      image.data[index + 2] = Math.floor(base - 8 + moss * 8);
      image.data[index + 3] = 255;
    }
  }
}

function fillNormalFromHeight(
  image: ImageData,
  size: number,
  scale: number,
  heightFn: (u: number, v: number) => number,
): void {
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      heights[y * size + x] = heightFn(x / size, y / size);
    }
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const left = heights[y * size + ((x - 1 + size) % size)];
      const right = heights[y * size + ((x + 1) % size)];
      const down = heights[((y - 1 + size) % size) * size + x];
      const up = heights[((y + 1) % size) * size + x];
      const dx = (right - left) * scale;
      const dy = (up - down) * scale;
      const index = (y * size + x) * 4;
      image.data[index] = Math.floor(128 - dx * 28);
      image.data[index + 1] = Math.floor(128 - dy * 28);
      image.data[index + 2] = 248;
      image.data[index + 3] = 255;
    }
  }
}

function fillRoughness(image: ImageData, size: number, base: number, variation: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const n =
        Math.sin(u * 52 + v * 41) * 0.5 +
        Math.sin(u * 118 - v * 88) * 0.3;
      const value = Math.floor((base + n * variation) * 255);
      const index = (y * size + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
}

function fillAo(image: ImageData, size: number, strength: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const cavity =
        Math.sin(u * 44 + v * 38) * 0.35 +
        Math.sin(u * 96 - v * 72) * 0.22;
      const value = Math.floor((0.72 + cavity * strength) * 255);
      const index = (y * size + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
}

function buildSurface(
  fillColor: (image: ImageData, size: number) => void,
  normalHeight: (u: number, v: number) => number,
  roughBase: number,
  roughVar: number,
  aoStrength: number,
): SurfaceTextureMaps {
  const { canvas: colorCanvas, ctx: colorCtx } = makeCanvas(TEXTURE_SIZE);
  const colorImage = colorCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  fillColor(colorImage, TEXTURE_SIZE);
  colorCtx.putImageData(colorImage, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(TEXTURE_SIZE);
  const normalImage = normalCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  fillNormalFromHeight(normalImage, TEXTURE_SIZE, 2.4, normalHeight);
  normalCtx.putImageData(normalImage, 0, 0);

  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(TEXTURE_SIZE);
  const roughImage = roughCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  fillRoughness(roughImage, TEXTURE_SIZE, roughBase, roughVar);
  roughCtx.putImageData(roughImage, 0, 0);

  const { canvas: aoCanvas, ctx: aoCtx } = makeCanvas(TEXTURE_SIZE);
  const aoImage = aoCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  fillAo(aoImage, TEXTURE_SIZE, aoStrength);
  aoCtx.putImageData(aoImage, 0, 0);

  return {
    color: toTexture(colorCanvas),
    normal: toTexture(normalCanvas, THREE.LinearSRGBColorSpace),
    roughness: toTexture(roughCanvas, THREE.LinearSRGBColorSpace),
    ao: toTexture(aoCanvas, THREE.LinearSRGBColorSpace),
  };
}

let terrainTextures: TerrainTextureSet | null = null;

export function getTerrainTextures(): TerrainTextureSet {
  if (terrainTextures) {
    return terrainTextures;
  }

  terrainTextures = {
    grass: buildSurface(
      fillGrassColor,
      (u, v) =>
        Math.sin(u * 28) * Math.cos(v * 31) * 0.45 +
        Math.sin(u * 64 + v * 12) * 0.22 +
        Math.sin(u * 140 - v * 90) * 0.1,
      0.86,
      0.14,
      0.22,
    ),
    dirt: buildSurface(
      fillDirtColor,
      (u, v) =>
        Math.sin(u * 48) * Math.cos(v * 52) * 0.4 +
        Math.sin(u * 96 + v * 17) * 0.25,
      0.94,
      0.08,
      0.28,
    ),
    rock: buildSurface(
      fillRockColor,
      (u, v) =>
        Math.sin(u * 36 + v * 42) * 0.5 +
        Math.sin(u * 88 - v * 64) * 0.28,
      0.78,
      0.18,
      0.32,
    ),
  };

  return terrainTextures;
}

export function applyTerrainTextureAnisotropy(renderer: THREE.WebGLRenderer): void {
  const max = renderer.capabilities.getMaxAnisotropy();
  const aniso = Math.min(8, max);
  const set = getTerrainTextures();
  for (const surface of [set.grass, set.dirt, set.rock]) {
    for (const texture of [surface.color, surface.normal, surface.roughness, surface.ao]) {
      texture.anisotropy = aniso;
      texture.needsUpdate = true;
    }
  }
}
