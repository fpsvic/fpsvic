import * as THREE from "three";

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = false;
}

let groundColorTexture: THREE.CanvasTexture | null = null;

export function createGroundColorTexture(): THREE.CanvasTexture {
  if (groundColorTexture) {
    return groundColorTexture;
  }

  const size = 128;
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
        Math.sin(nx * 24) * Math.cos(ny * 26) * 0.5 + Math.sin(nx * 58 + ny * 11) * 0.25 + 0.5;
      const index = (y * size + x) * 4;
      image.data[index] = Math.floor(42 + n * 68);
      image.data[index + 1] = Math.floor(76 + n * 88);
      image.data[index + 2] = Math.floor(32 + n * 42);
      const moss = Math.sin(nx * 40 + ny * 33) > 0.62 ? 8 : 0;
      image.data[index + 1] = Math.min(255, image.data[index + 1] + moss);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  groundColorTexture = new THREE.CanvasTexture(canvas);
  groundColorTexture.wrapS = THREE.RepeatWrapping;
  groundColorTexture.wrapT = THREE.RepeatWrapping;
  groundColorTexture.repeat.set(12, 12);
  groundColorTexture.colorSpace = THREE.SRGBColorSpace;
  groundColorTexture.anisotropy = 2;
  return groundColorTexture;
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
  gradient.addColorStop(0, "rgba(0,0,0,0.5)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function addSkyDome(scene: THREE.Scene): THREE.Color {
  const geometry = new THREE.SphereGeometry(240, 10, 5);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const zenith = new THREE.Color(0x3d6a9e);
  const horizon = new THREE.Color(0xa8c4e0);
  const haze = new THREE.Color(0xc8dce8);
  const mountain = new THREE.Color(0x2e3f4c);
  const forestSilhouette = new THREE.Color(0x1f3428);
  const vertex = new THREE.Vector3();
  const color = new THREE.Color();

  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    vertex.fromBufferAttribute(geometry.attributes.position, index);
    const t = THREE.MathUtils.clamp(vertex.y / 240 + 0.02, 0, 1);
    color.copy(horizon).lerp(zenith, Math.pow(t, 0.85));
    if (t < 0.42) {
      color.lerp(haze, (0.42 - t) * 0.55);
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
      color.lerp(mountain, mountainMask * 0.82);
      if (vertex.y < 18) {
        color.lerp(forestSilhouette, mountainMask * 0.28 * (1 - t));
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

export function setupLighting(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xc8e4ff, 0x3d5c32, 0.72));
  const sun = new THREE.DirectionalLight(0xfff0d4, 1.4);
  sun.position.set(52, 68, 28);
  scene.add(sun);
}
