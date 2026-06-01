import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type GroundMaps = {
  color: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
};

export function configureRenderer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = false;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

function paintNoisePixel(
  image: ImageData,
  x: number,
  y: number,
  size: number,
  noise: number,
): void {
  const patch = noise * 0.22;
  const r = Math.floor(52 + patch * 85 + noise * 25);
  const g = Math.floor(88 + patch * 110 + noise * 20);
  const b = Math.floor(38 + patch * 45);
  const index = (y * size + x) * 4;
  image.data[index] = r;
  image.data[index + 1] = g;
  image.data[index + 2] = b;
  image.data[index + 3] = 255;
}

export function createGroundMaps(): GroundMaps {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create ground texture.");
  }

  const heights = new Float32Array(size * size);
  const image = ctx.createImageData(size, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      const n =
        Math.sin(nx * 42) * Math.cos(ny * 38) * 0.5 +
        Math.sin(nx * 96 + ny * 17) * 0.28 +
        Math.sin((nx + ny) * 55) * 0.15 +
        0.5;
      const dirtPatch = Math.sin(nx * 11 + 2.1) * Math.sin(ny * 9 + 1.3) > 0.35 ? 0.12 : 0;
      const height = n + dirtPatch;
      heights[y * size + x] = height;
      paintNoisePixel(image, x, y, size, height);
    }
  }
  ctx.putImageData(image, 0, 0);

  const color = new THREE.CanvasTexture(canvas);
  color.wrapS = THREE.RepeatWrapping;
  color.wrapT = THREE.RepeatWrapping;
  color.repeat.set(16, 16);
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = 8;

  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = size;
  normalCanvas.height = size;
  const normalCtx = normalCanvas.getContext("2d");
  if (!normalCtx) {
    throw new Error("Unable to create ground normal map.");
  }

  const normalImage = normalCtx.createImageData(size, size);
  const strength = 2.4 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const left = heights[y * size + Math.max(0, x - 1)];
      const right = heights[y * size + Math.min(size - 1, x + 1)];
      const up = heights[Math.max(0, y - 1) * size + x];
      const down = heights[Math.min(size - 1, y + 1) * size + x];
      const dx = (right - left) * strength;
      const dy = (down - up) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz) || 1;
      const index = (y * size + x) * 4;
      normalImage.data[index] = Math.floor(((nx / length) * 0.5 + 0.5) * 255);
      normalImage.data[index + 1] = Math.floor(((ny / length) * 0.5 + 0.5) * 255);
      normalImage.data[index + 2] = Math.floor(((nz / length) * 0.5 + 0.5) * 255);
      normalImage.data[index + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImage, 0, 0);

  const normal = new THREE.CanvasTexture(normalCanvas);
  normal.wrapS = THREE.RepeatWrapping;
  normal.wrapT = THREE.RepeatWrapping;
  normal.repeat.set(16, 16);
  normal.colorSpace = THREE.LinearSRGBColorSpace;

  return { color, normal };
}

export function createBlobShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create blob shadow texture.");
  }

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(0.55, "rgba(0,0,0,0.22)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function addSkyDome(scene: THREE.Scene): THREE.Color {
  const geometry = new THREE.SphereGeometry(240, 16, 8);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const zenith = new THREE.Color(0x3d6da8);
  const horizon = new THREE.Color(0xa8c4e2);
  const haze = new THREE.Color(0xc8d8c0);
  const vertex = new THREE.Vector3();
  const color = new THREE.Color();

  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    vertex.fromBufferAttribute(geometry.attributes.position, index);
    const t = THREE.MathUtils.clamp(vertex.y / 240 + 0.02, 0, 1);
    if (t > 0.52) {
      color.copy(horizon).lerp(zenith, Math.pow((t - 0.52) / 0.48, 0.75));
    } else {
      color.copy(haze).lerp(horizon, Math.pow(t / 0.52, 0.85));
    }
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  scene.add(sky);

  const sunGlow = new THREE.Mesh(
    new THREE.SphereGeometry(8, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xfff4d6,
      transparent: true,
      opacity: 0.92,
      fog: false,
    }),
  );
  sunGlow.position.set(95, 118, 48);
  scene.add(sunGlow);

  return horizon;
}

export function setupLighting(scene: THREE.Scene): THREE.DirectionalLight {
  const hemi = new THREE.HemisphereLight(0xc8e4ff, 0x4a5c38, 0.62);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dc, 1.85);
  sun.position.set(52, 72, 28);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x9ec8ff, 0.55);
  fill.position.set(-38, 34, -44);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffc9a0, 0.28);
  rim.position.set(-18, 22, 52);
  scene.add(rim);

  return sun;
}
