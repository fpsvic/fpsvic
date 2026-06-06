import * as THREE from "three";
import {
  getConiferFoliageGeometry,
  getConiferFoliageMaterial,
  getConiferTrunkGeometry,
  getConiferTrunkMaterial,
  placeConiferInstances,
  sampleArenaTreeGroundY,
  type ConiferPlacement,
} from "./coniferTrees";
import { ARENA_RADIUS } from "./terrain";

const mountainGeometry = new THREE.ConeGeometry(1, 1, 5);
const mountainMaterial = new THREE.MeshStandardMaterial({
  color: 0x3a4d5e,
  roughness: 0.95,
  metalness: 0.02,
  envMapIntensity: 0.38,
  fog: true,
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

function sampleForestPlacements(count: number): ConiferPlacement[] {
  const placements: ConiferPlacement[] = [];
  let attempts = 0;

  while (placements.length < count && attempts < count * 12) {
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

    const scale = 0.68 + hash01(attempts * 5.5) * 0.58;
    const groundY = sampleArenaTreeGroundY(x, z);
    const yaw = hash01(attempts * 6.1) * Math.PI * 2;

    placements.push({ x, z, scale, yaw, groundY });
  }

  return placements;
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
  const trunks = new THREE.InstancedMesh(
    getConiferTrunkGeometry(),
    getConiferTrunkMaterial(),
    forestCount,
  );
  const foliage = new THREE.InstancedMesh(
    getConiferFoliageGeometry(),
    getConiferFoliageMaterial(),
    forestCount,
  );
  trunks.castShadow = false;
  foliage.castShadow = false;
  placeConiferInstances(trunks, foliage, sampleForestPlacements(forestCount));
  scenery.add(trunks, foliage);

  return scenery;
}
