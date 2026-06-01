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
        Math.sin(nx * 24) * Math.cos(ny * 26) * 0.5 + Math.sin(nx * 58 + ny * 11) * 0.25 + 0.5;
      const index = (y * size + x) * 4;
      image.data[index] = Math.floor(48 + n * 75);
      image.data[index + 1] = Math.floor(82 + n * 95);
      image.data[index + 2] = Math.floor(36 + n * 38);
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
  const geometry = new THREE.SphereGeometry(240, 8, 4);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const zenith = new THREE.Color(0x4a72a8);
  const horizon = new THREE.Color(0x9eb4d0);
  const vertex = new THREE.Vector3();
  const color = new THREE.Color();

  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    vertex.fromBufferAttribute(geometry.attributes.position, index);
    const t = THREE.MathUtils.clamp(vertex.y / 240 + 0.02, 0, 1);
    color.copy(horizon).lerp(zenith, Math.pow(t, 0.8));
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
  scene.add(new THREE.HemisphereLight(0xb8dcff, 0x3f5a36, 0.7));
  const sun = new THREE.DirectionalLight(0xfff2dc, 1.45);
  sun.position.set(48, 62, 24);
  scene.add(sun);
}
