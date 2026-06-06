import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

let groundColorTexture: THREE.CanvasTexture | null = null;
let groundNormalTexture: THREE.CanvasTexture | null = null;
let environmentTexture: THREE.Texture | null = null;

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
}

export function applySceneEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): void {
  if (environmentTexture) {
    scene.environment = environmentTexture;
    return;
  }

  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    environmentTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = environmentTexture;
  } catch (error) {
    console.warn("Failed to build scene environment map:", error);
  }
}

export function setSceneEnvironmentEnabled(scene: THREE.Scene, enabled: boolean): void {
  scene.environment = enabled && environmentTexture ? environmentTexture : null;
}

export function ensureSceneEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): void {
  if (!environmentTexture) {
    applySceneEnvironment(scene, renderer);
  }
}

export function createGroundColorTexture(): THREE.CanvasTexture {
  if (groundColorTexture) {
    return groundColorTexture;
  }

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create ground texture.");
  }

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      const n =
        Math.sin(nx * 28) * Math.cos(ny * 31) * 0.45 +
        Math.sin(nx * 64 + ny * 12) * 0.22 +
        0.5;
      const patch = Math.sin(nx * 112 + ny * 97) > 0.55 ? 0.08 : 0;
      const index = (y * size + x) * 4;
      image.data[index] = Math.floor(38 + n * 72 + patch * 18);
      image.data[index + 1] = Math.floor(68 + n * 92 + patch * 24);
      image.data[index + 2] = Math.floor(28 + n * 48 + patch * 8);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  groundColorTexture = new THREE.CanvasTexture(canvas);
  groundColorTexture.wrapS = THREE.RepeatWrapping;
  groundColorTexture.wrapT = THREE.RepeatWrapping;
  groundColorTexture.repeat.set(14, 14);
  groundColorTexture.colorSpace = THREE.SRGBColorSpace;
  groundColorTexture.anisotropy = 4;
  return groundColorTexture;
}

export function createGroundNormalTexture(): THREE.CanvasTexture {
  if (groundNormalTexture) {
    return groundNormalTexture;
  }

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create ground normal texture.");
  }

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size;
      const ny = y / size;
      const bump =
        Math.sin(nx * 48) * Math.cos(ny * 52) * 0.35 +
        Math.sin(nx * 96 + ny * 17) * 0.2;
      const index = (y * size + x) * 4;
      image.data[index] = Math.floor(128 + bump * 28);
      image.data[index + 1] = Math.floor(128 + bump * 28);
      image.data[index + 2] = Math.floor(240 + bump * 12);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  groundNormalTexture = new THREE.CanvasTexture(canvas);
  groundNormalTexture.wrapS = THREE.RepeatWrapping;
  groundNormalTexture.wrapT = THREE.RepeatWrapping;
  groundNormalTexture.repeat.set(14, 14);
  return groundNormalTexture;
}

export function createBlobShadowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create blob shadow texture.");
  }

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function addSkyDome(scene: THREE.Scene): THREE.Color {
  const geometry = new THREE.SphereGeometry(320, 24, 12);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const zenith = new THREE.Color(0x3a8fd4);
  const horizon = new THREE.Color(0xb8e8ff);
  const haze = new THREE.Color(0xe8f6ff);
  const sunGlow = new THREE.Color(0xfff8e8);
  const cloud = new THREE.Color(0xffffff);
  const mountain = new THREE.Color(0x2a3a48);
  const forestSilhouette = new THREE.Color(0x1a2e22);
  const vertex = new THREE.Vector3();
  const color = new THREE.Color();

  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    vertex.fromBufferAttribute(geometry.attributes.position, index);
    const t = THREE.MathUtils.clamp(vertex.y / 240 + 0.02, 0, 1);
    color.copy(horizon).lerp(zenith, Math.pow(t, 0.9));
    if (t < 0.5) {
      color.lerp(haze, (0.5 - t) * 0.45);
    }

    const sunSide = THREE.MathUtils.clamp((vertex.x + vertex.z) / 320 + 0.35, 0, 1);
    if (t > 0.28) {
      color.lerp(sunGlow, sunSide * 0.18 * t);
    }

    const cloudNoise =
      Math.sin(vertex.x * 0.08 + vertex.z * 0.06) *
      Math.cos(vertex.y * 0.12 + vertex.z * 0.05);
    if (t > 0.55 && cloudNoise > 0.35) {
      color.lerp(cloud, (cloudNoise - 0.35) * 0.22);
    }

    const azimuth = Math.atan2(vertex.x, vertex.z);
    const ridge =
      Math.sin(azimuth * 3.2) * 0.42 +
      Math.sin(azimuth * 7.1 + 1.4) * 0.24 +
      Math.sin(azimuth * 11.5 + 2.1) * 0.14 +
      0.52;
    const elevation = THREE.MathUtils.clamp(1 - Math.abs(vertex.y) / 52, 0, 1);
    const mountainMask = elevation * THREE.MathUtils.smoothstep(ridge, 0.38, 0.92);

    if (vertex.y < 36) {
      color.lerp(mountain, mountainMask * 0.85);
      if (vertex.y < 18) {
        color.lerp(forestSilhouette, mountainMask * 0.32 * (1 - t));
      }
    }

    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  scene.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    ),
  );

  return horizon;
}

export function setupLighting(scene: THREE.Scene): THREE.DirectionalLight {
  scene.add(new THREE.AmbientLight(0xa8c8e8, 0.28));
  scene.add(new THREE.HemisphereLight(0xd8f0ff, 0x5a8a48, 0.78));

  const sun = new THREE.DirectionalLight(0xfff0d0, 1.95);
  sun.position.set(58, 78, 32);
  sun.target.position.set(0, 0, 0);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.02;
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 220;
  sun.shadow.camera.left = -108;
  sun.shadow.camera.right = 108;
  sun.shadow.camera.top = 108;
  sun.shadow.camera.bottom = -108;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xb8dcff, 0.48);
  fill.position.set(-42, 34, -48);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x9ee8ff, 0.62);
  rim.position.set(-28, 42, 58);
  scene.add(rim);

  return sun;
}

export function syncSunShadowQuality(sun: THREE.DirectionalLight, size: number): void {
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    sun.shadow.needsUpdate = true;
  }
}
