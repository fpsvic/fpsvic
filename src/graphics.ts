import * as THREE from "three";

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.14;
  renderer.shadowMap.enabled = false;
}

export function createGroundTexture(): THREE.CanvasTexture {
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
        Math.sin(nx * 28) * Math.cos(ny * 31) * 0.5 +
        Math.sin(nx * 71 + ny * 13) * 0.25 +
        0.5;
      const moss = 0.32 + n * 0.18;
      const r = Math.floor((55 + moss * 70) * (0.92 + nx * 0.08));
      const g = Math.floor((95 + moss * 85) * (0.9 + ny * 0.1));
      const b = Math.floor(45 + moss * 35);
      const index = (y * size + x) * 4;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(14, 14);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function addSkyDome(scene: THREE.Scene): void {
  const geometry = new THREE.SphereGeometry(240, 14, 7);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  const top = new THREE.Color(0x4f7eb8);
  const horizon = new THREE.Color(0x9eb8d4);
  const low = new THREE.Color(0x6a8a62);
  const vertex = new THREE.Vector3();
  const color = new THREE.Color();

  for (let index = 0; index < geometry.attributes.position.count; index += 1) {
    vertex.fromBufferAttribute(geometry.attributes.position, index);
    const t = THREE.MathUtils.clamp(vertex.y / 240 + 0.02, 0, 1);
    if (t > 0.5) {
      color.copy(horizon).lerp(top, (t - 0.5) * 2);
    } else {
      color.copy(low).lerp(horizon, t * 2);
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
}

export function setupLighting(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xb8dcff, 0x3f5a36, 0.95));
  const sun = new THREE.DirectionalLight(0xfff0d4, 1.55);
  sun.position.set(48, 62, 22);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8ab4e8, 0.42);
  fill.position.set(-32, 28, -40);
  scene.add(fill);
}
