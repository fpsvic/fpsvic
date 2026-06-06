import * as THREE from "three";
import type { HumanoidPalette } from "./humanoid";

const TEXTURE_SIZE = 128;

type TextureSet = {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
};

let camoTextures: TextureSet | null = null;
let nylonTextures: TextureSet | null = null;

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create soldier texture canvas.");
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
  texture.anisotropy = 4;
  return texture;
}

function camoNoise(u: number, v: number, scale: number): number {
  return (
    Math.sin(u * scale + v * scale * 0.7) * 0.5 +
    Math.sin(u * scale * 2.3 - v * scale * 1.8) * 0.28 +
    Math.sin(u * scale * 4.1 + v * scale * 3.2) * 0.14
  );
}

function createCamoTextures(): TextureSet {
  const { canvas, ctx } = makeCanvas(TEXTURE_SIZE);
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const blobA = camoNoise(u, v, 11);
      const blobB = camoNoise(u + 0.37, v + 0.21, 17);
      const blobC = camoNoise(u - 0.18, v + 0.44, 23);
      const weave =
        Math.sin(u * 96 + v * 88) * 0.06 + Math.sin(u * 180 - v * 140) * 0.04;

      let r = 28;
      let g = 38;
      let b = 32;

      if (blobA > 0.18) {
        r = 18;
        g = 52;
        b = 28;
      }
      if (blobB > 0.22) {
        r = 12;
        g = 28;
        b = 42;
      }
      if (blobC > 0.28) {
        r = 8;
        g = 14;
        b = 18;
      }

      const grain = weave * 255;
      const index = (y * TEXTURE_SIZE + x) * 4;
      image.data[index] = Math.min(255, Math.max(0, r + grain));
      image.data[index + 1] = Math.min(255, Math.max(0, g + grain));
      image.data[index + 2] = Math.min(255, Math.max(0, b + grain));
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(TEXTURE_SIZE);
  const normalImage = normalCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(TEXTURE_SIZE);
  const roughImage = roughCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const warp =
        Math.sin(u * Math.PI * 52) * 0.5 + Math.sin(v * Math.PI * 52) * 0.5;
      const bump =
        Math.sin(u * 140 + v * 110) * 0.35 + Math.sin(u * 280 - v * 220) * 0.2;
      const index = (y * TEXTURE_SIZE + x) * 4;
      normalImage.data[index] = Math.floor(128 + warp * 16 + bump * 8);
      normalImage.data[index + 1] = Math.floor(128 + warp * 16 + bump * 8);
      normalImage.data[index + 2] = Math.floor(248 + bump * 6);
      normalImage.data[index + 3] = 255;
      const rough = Math.floor((0.78 + warp * 0.14 + Math.abs(bump) * 0.08) * 255);
      roughImage.data[index] = rough;
      roughImage.data[index + 1] = rough;
      roughImage.data[index + 2] = rough;
      roughImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);

  return {
    map: toTexture(canvas),
    normalMap: toTexture(normalCanvas, THREE.LinearSRGBColorSpace),
    roughnessMap: toTexture(roughCanvas, THREE.LinearSRGBColorSpace),
  };
}

function createNylonTextures(): TextureSet {
  const { canvas, ctx } = makeCanvas(TEXTURE_SIZE);
  const image = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const weave =
        Math.sin(u * 180 + v * 140) * 0.5 + Math.sin(u * 320 - v * 260) * 0.28;
      const index = (y * TEXTURE_SIZE + x) * 4;
      const shade = 34 + weave * 14;
      image.data[index] = shade;
      image.data[index + 1] = shade + 2;
      image.data[index + 2] = shade + 4;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(TEXTURE_SIZE);
  const normalImage = normalCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(TEXTURE_SIZE);
  const roughImage = roughCtx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const u = x / TEXTURE_SIZE;
      const v = y / TEXTURE_SIZE;
      const bump = Math.sin(u * 220 + v * 180) * 0.4;
      const index = (y * TEXTURE_SIZE + x) * 4;
      normalImage.data[index] = Math.floor(128 + bump * 18);
      normalImage.data[index + 1] = Math.floor(128 + bump * 18);
      normalImage.data[index + 2] = 248;
      normalImage.data[index + 3] = 255;
      const rough = Math.floor((0.82 + Math.abs(bump) * 0.12) * 255);
      roughImage.data[index] = rough;
      roughImage.data[index + 1] = rough;
      roughImage.data[index + 2] = rough;
      roughImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);

  return {
    map: toTexture(canvas),
    normalMap: toTexture(normalCanvas, THREE.LinearSRGBColorSpace),
    roughnessMap: toTexture(roughCanvas, THREE.LinearSRGBColorSpace),
  };
}

function cloneTextureSet(set: TextureSet): TextureSet {
  const clone = (texture: THREE.CanvasTexture) => {
    const next = texture.clone();
    next.repeat.copy(texture.repeat);
    next.needsUpdate = true;
    return next;
  };
  return {
    map: clone(set.map),
    normalMap: clone(set.normalMap),
    roughnessMap: clone(set.roughnessMap),
  };
}

function makeCamoMaterial(
  color: THREE.ColorRepresentation,
  repeat: number,
): THREE.MeshPhysicalMaterial {
  camoTextures ??= createCamoTextures();
  const tex = cloneTextureSet(camoTextures);
  tex.map.repeat.set(repeat, repeat);
  tex.normalMap.repeat.set(repeat, repeat);
  tex.roughnessMap.repeat.set(repeat, repeat);

  return new THREE.MeshPhysicalMaterial({
    color,
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    normalScale: new THREE.Vector2(0.72, 0.72),
    roughness: 1,
    metalness: 0.03,
    sheen: 0.18,
    sheenRoughness: 0.88,
    sheenColor: new THREE.Color(0x8aa090),
    envMapIntensity: 0.88,
  });
}

function makeNylonMaterial(color: THREE.ColorRepresentation): THREE.MeshPhysicalMaterial {
  nylonTextures ??= createNylonTextures();
  const tex = cloneTextureSet(nylonTextures);
  tex.map.repeat.set(2.8, 2.8);
  tex.normalMap.repeat.set(2.8, 2.8);
  tex.roughnessMap.repeat.set(2.8, 2.8);

  return new THREE.MeshPhysicalMaterial({
    color,
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 1,
    metalness: 0.05,
    envMapIntensity: 0.72,
  });
}

export type SoldierPalette = HumanoidPalette & {
  beret: THREE.Material;
  gloves: THREE.Material;
  vest: THREE.Material;
  gear: THREE.Material;
  emblem: THREE.Material;
};

export function createSoldierPalette(): SoldierPalette {
  const camoUniform = makeCamoMaterial(0xffffff, 3.2);
  const camoVest = makeCamoMaterial(0xd8e0d8, 2.6);
  const camoPants = makeCamoMaterial(0xe8ece8, 3.4);

  const skin = new THREE.MeshPhysicalMaterial({
    color: 0xc49a78,
    roughness: 0.58,
    metalness: 0,
    sheen: 0.28,
    sheenRoughness: 0.72,
    sheenColor: new THREE.Color(0xffe0cc),
    envMapIntensity: 0.95,
  });

  const boots = new THREE.MeshPhysicalMaterial({
    color: 0x0a0808,
    roughness: 0.78,
    metalness: 0.06,
    envMapIntensity: 0.82,
  });

  const beret = new THREE.MeshPhysicalMaterial({
    color: 0x121820,
    roughness: 0.88,
    metalness: 0.02,
    sheen: 0.32,
    sheenRoughness: 0.82,
    sheenColor: new THREE.Color(0x3a4858),
    envMapIntensity: 0.62,
  });

  const gloves = new THREE.MeshPhysicalMaterial({
    color: 0x1a1c1e,
    roughness: 0.72,
    metalness: 0.04,
    normalScale: new THREE.Vector2(0.35, 0.35),
    envMapIntensity: 0.78,
  });

  const gear = makeNylonMaterial(0x1e2228);
  const emblem = new THREE.MeshStandardMaterial({
    color: 0xb8a060,
    roughness: 0.35,
    metalness: 0.82,
    envMapIntensity: 1.1,
  });

  return {
    skin,
    shirt: camoUniform,
    pants: camoPants,
    boots,
    beret,
    gloves,
    vest: camoVest,
    gear,
    emblem,
  };
}

export function collectSoldierFlashMaterials(palette: SoldierPalette): THREE.Material[] {
  return [
    palette.skin,
    palette.shirt,
    palette.pants,
    palette.boots,
    palette.beret,
    palette.gloves,
    palette.vest,
    palette.gear,
    palette.emblem,
  ];
}
