import * as THREE from "three";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";

const mountainGeometry = new THREE.ConeGeometry(1, 1, 5);
const mountainMaterial = new THREE.MeshStandardMaterial({
  color: 0x3a4d5e,
  roughness: 0.95,
  metalness: 0.02,
  envMapIntensity: 0.38,
  fog: true,
});

const trunkGeometry = new THREE.CylinderGeometry(0.14, 0.2, 1.15, 4);
const foliageGeometry = new THREE.ConeGeometry(0.95, 2.35, 5);
const trunkMaterial = new THREE.MeshStandardMaterial({
  color: 0x4a3528,
  roughness: 0.88,
  metalness: 0.02,
  envMapIntensity: 0.45,
});
const foliageMaterial = new THREE.MeshStandardMaterial({
  color: 0x2f5c38,
  roughness: 0.82,
  metalness: 0.02,
  emissive: new THREE.Color(0x142818),
  emissiveIntensity: 0.06,
  envMapIntensity: 0.42,
});

const dummy = new THREE.Object3D();

function hash01(seed: number): number {
  const value = Math.sin(seed * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

function placeMountainInstances(mountains: THREE.InstancedMesh, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + hash01(index * 1.7) * 0.35;
    const radius = 132 + hash01(index * 2.3) * 58;
    const width = 14 + hash01(index * 3.1) * 22;
    const height = 26 + hash01(index * 4.9) * 38;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    dummy.position.set(x, height * 0.42 - 4, z);
    dummy.rotation.set(0, angle + Math.PI + hash01(index * 5.7) * 0.2, 0);
    dummy.scale.set(width, height, width * (0.75 + hash01(index * 6.2) * 0.2));
    dummy.updateMatrix();
    mountains.setMatrixAt(index, dummy.matrix);
  }
  mountains.instanceMatrix.needsUpdate = true;
}

function treeGroundY(x: number, z: number): number {
  const dist = Math.hypot(x, z);
  if (dist <= ARENA_RADIUS + 1) {
    return sampleTerrainHeight(x, z);
  }
  return -0.15 + hash01(x * 0.17 + z * 0.23) * 0.35;
}

function placeForestInstances(
  trunks: THREE.InstancedMesh,
  foliage: THREE.InstancedMesh,
  count: number,
): void {
  let placed = 0;
  let attempts = 0;

  while (placed < count && attempts < count * 12) {
    attempts += 1;
    const angle = hash01(attempts * 1.13) * Math.PI * 2;
    const radius =
      ARENA_RADIUS * (0.42 + hash01(attempts * 2.07) * 0.72) +
      hash01(attempts * 3.31) * 38;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const dist = Math.hypot(x, z);

    if (dist < 10 || dist > ARENA_RADIUS + 48) {
      continue;
    }

    if (dist < 22 && hash01(attempts * 4.2) > 0.38) {
      continue;
    }

    const scale = 0.72 + hash01(attempts * 5.5) * 0.55;
    const groundY = treeGroundY(x, z);
    const yaw = hash01(attempts * 6.1) * Math.PI * 2;

    dummy.position.set(x, groundY + 0.58 * scale, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(placed, dummy.matrix);

    dummy.position.set(x, groundY + 1.45 * scale, z);
    dummy.updateMatrix();
    foliage.setMatrixAt(placed, dummy.matrix);

    placed += 1;
  }

  trunks.count = placed;
  foliage.count = placed;
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
}

/** Static mountains + instanced forests (cheap draw calls). */
export function createBackdropScenery(): THREE.Group {
  const scenery = new THREE.Group();
  scenery.name = "backdrop-scenery";

  const mountainCount = 20;
  const mountains = new THREE.InstancedMesh(mountainGeometry, mountainMaterial, mountainCount);
  mountains.castShadow = false;
  mountains.frustumCulled = true;
  placeMountainInstances(mountains, mountainCount);
  scenery.add(mountains);

  const forestCount = 42;
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, forestCount);
  const foliage = new THREE.InstancedMesh(foliageGeometry, foliageMaterial, forestCount);
  trunks.castShadow = false;
  foliage.castShadow = false;
  placeForestInstances(trunks, foliage, forestCount);
  scenery.add(trunks, foliage);

  return scenery;
}
