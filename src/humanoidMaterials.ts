import * as THREE from "three";
import type { HumanoidPalette } from "./humanoid";

type TextureSet = {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
};

let skinTextures: TextureSet | null = null;
let fabricTextures: TextureSet | null = null;
let leatherTextures: TextureSet | null = null;

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create humanoid texture canvas.");
  }
  return { canvas, ctx };
}

function canvasToTexture(
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

function getSkinTextures(): TextureSet {
  if (skinTextures) {
    return skinTextures;
  }

  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const grain =
        Math.sin(u * 94 + v * 71) * 0.08 +
        Math.sin(u * 211 - v * 143) * 0.05 +
        Math.sin(u * 317 + v * 199) * 0.035;
      const freckle = Math.sin(u * 38) * Math.cos(v * 41) > 0.72 ? -0.06 : 0;
      const index = (y * size + x) * 4;
      const base = 210 + grain * 40 + freckle * 35;
      image.data[index] = Math.min(255, base + 18);
      image.data[index + 1] = Math.min(255, base - 8);
      image.data[index + 2] = Math.min(255, base - 42);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(size);
  const normalImage = normalCtx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const bump =
        Math.sin(u * 120 + v * 88) * 0.35 +
        Math.sin(u * 240 - v * 160) * 0.22;
      const index = (y * size + x) * 4;
      normalImage.data[index] = Math.floor(128 + bump * 22);
      normalImage.data[index + 1] = Math.floor(128 + bump * 22);
      normalImage.data[index + 2] = Math.floor(248 + bump * 6);
      normalImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);

  const map = canvasToTexture(canvas);
  map.repeat.set(2.2, 2.2);
  const normalMap = canvasToTexture(normalCanvas, THREE.LinearSRGBColorSpace);
  normalMap.repeat.set(2.2, 2.2);

  skinTextures = { map, normalMap };
  return skinTextures;
}

function getFabricTextures(): TextureSet {
  if (fabricTextures) {
    return fabricTextures;
  }

  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const weaveX = Math.sin((x / size) * Math.PI * 24) * 0.5 + 0.5;
      const weaveY = Math.sin((y / size) * Math.PI * 24) * 0.5 + 0.5;
      const thread = weaveX * 0.55 + weaveY * 0.45;
      const index = (y * size + x) * 4;
      const shade = 118 + thread * 28;
      image.data[index] = shade;
      image.data[index + 1] = shade + 4;
      image.data[index + 2] = shade - 6;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(size);
  const normalImage = normalCtx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const warp =
        Math.sin(u * Math.PI * 48) * 0.55 + Math.sin(v * Math.PI * 48) * 0.55;
      const index = (y * size + x) * 4;
      normalImage.data[index] = Math.floor(128 + warp * 18);
      normalImage.data[index + 1] = Math.floor(128 + warp * 18);
      normalImage.data[index + 2] = 248;
      normalImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);

  const map = canvasToTexture(canvas);
  map.repeat.set(3.5, 3.5);
  const normalMap = canvasToTexture(normalCanvas, THREE.LinearSRGBColorSpace);
  normalMap.repeat.set(3.5, 3.5);

  fabricTextures = { map, normalMap };
  return fabricTextures;
}

function getLeatherTextures(): TextureSet {
  if (leatherTextures) {
    return leatherTextures;
  }

  const size = 96;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const crease = Math.sin(u * 18 + v * 12) * 0.25 + Math.sin(v * 44) * 0.15;
      const index = (y * size + x) * 4;
      const tone = 42 + crease * 28;
      image.data[index] = tone;
      image.data[index + 1] = tone - 4;
      image.data[index + 2] = tone - 10;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const { canvas: normalCanvas, ctx: normalCtx } = makeCanvas(size);
  const normalImage = normalCtx.createImageData(size, size);
  const { canvas: roughCanvas, ctx: roughCtx } = makeCanvas(size);
  const roughImage = roughCtx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const bump =
        Math.sin(u * 52 + v * 38) * 0.4 + Math.sin(u * 110 - v * 90) * 0.22;
      const index = (y * size + x) * 4;
      normalImage.data[index] = Math.floor(128 + bump * 20);
      normalImage.data[index + 1] = Math.floor(128 + bump * 20);
      normalImage.data[index + 2] = 248;
      normalImage.data[index + 3] = 255;
      const r =
        150 +
        Math.sin(u * 52 + v * 38) * 35 +
        Math.sin(u * 110 - v * 90) * 18;
      roughImage.data[index] = r;
      roughImage.data[index + 1] = r;
      roughImage.data[index + 2] = r;
      roughImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);
  roughCtx.putImageData(roughImage, 0, 0);

  const map = canvasToTexture(canvas);
  map.repeat.set(2, 2);
  const normalMap = canvasToTexture(normalCanvas, THREE.LinearSRGBColorSpace);
  normalMap.repeat.set(2, 2);
  const roughnessMap = canvasToTexture(roughCanvas, THREE.LinearSRGBColorSpace);
  roughnessMap.repeat.set(2, 2);

  leatherTextures = { map, normalMap, roughnessMap };
  return leatherTextures;
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
    roughnessMap: set.roughnessMap ? clone(set.roughnessMap) : undefined,
  };
}

export type HumanoidPaletteOptions = {
  skinColor: THREE.ColorRepresentation;
  shirtColor: THREE.ColorRepresentation;
  pantsColor: THREE.ColorRepresentation;
  bootsColor: THREE.ColorRepresentation;
  hairColor?: THREE.ColorRepresentation;
};

export function createHumanoidPalette(options: HumanoidPaletteOptions): HumanoidPalette {
  const skinTex = cloneTextureSet(getSkinTextures());
  const fabricTex = cloneTextureSet(getFabricTextures());
  const leatherTex = cloneTextureSet(getLeatherTextures());

  const skin = new THREE.MeshPhysicalMaterial({
    color: options.skinColor,
    map: skinTex.map,
    normalMap: skinTex.normalMap,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.52,
    metalness: 0,
    sheen: 0.42,
    sheenRoughness: 0.65,
    sheenColor: new THREE.Color(0xffe8dc),
    emissive: new THREE.Color(0x4a2018),
    emissiveIntensity: 0.055,
    clearcoat: 0.08,
    clearcoatRoughness: 0.4,
    envMapIntensity: 1.05,
  });

  const shirt = new THREE.MeshPhysicalMaterial({
    color: options.shirtColor,
    map: fabricTex.map,
    normalMap: fabricTex.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 0.82,
    metalness: 0.04,
    sheen: 0.22,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0xc8d4e0),
    envMapIntensity: 0.92,
  });

  const pants = new THREE.MeshPhysicalMaterial({
    color: options.pantsColor,
    map: fabricTex.map,
    normalMap: fabricTex.normalMap,
    normalScale: new THREE.Vector2(0.48, 0.48),
    roughness: 0.9,
    metalness: 0.02,
    envMapIntensity: 0.78,
  });

  const boots = new THREE.MeshPhysicalMaterial({
    color: options.bootsColor,
    map: leatherTex.map,
    normalMap: leatherTex.normalMap,
    roughnessMap: leatherTex.roughnessMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.72,
    metalness: 0.08,
    envMapIntensity: 0.88,
  });

  const hairColor = options.hairColor ?? 0x2a2018;
  const hair = new THREE.MeshPhysicalMaterial({
    color: hairColor,
    roughness: 0.88,
    metalness: 0.02,
    sheen: 0.35,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(0x6a5848),
    envMapIntensity: 0.5,
  });

  return { skin, shirt, pants, boots, hair };
}

export function setPaletteFlash(palette: HumanoidPalette, flashing: boolean): void {
  const materials = [palette.skin, palette.shirt, palette.pants, palette.boots];
  for (const material of materials) {
    const mat = material as THREE.MeshPhysicalMaterial;
    mat.transparent = flashing;
    mat.opacity = flashing ? 0.52 : 1;
    if (!flashing) {
      mat.transparent = false;
      mat.opacity = 1;
    }
  }
}
