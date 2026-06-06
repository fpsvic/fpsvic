import * as THREE from "three";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";
import { registerBuildingShelter } from "./shelter";

export type BuildingKind = "cabin" | "bunker" | "shed" | "ruin";

export type ArenaBuilding = {
  root: THREE.Group;
  kind: BuildingKind;
  x: number;
  z: number;
  yaw: number;
  outerRadius: number;
  doorHalfWidth: number;
  shelterRadius: number;
};

const woodMaterial = new THREE.MeshStandardMaterial({
  color: 0x6a5240,
  roughness: 0.86,
  metalness: 0.04,
});
const woodTrim = new THREE.MeshStandardMaterial({
  color: 0x4a3828,
  roughness: 0.82,
  metalness: 0.05,
});
const roofMaterial = new THREE.MeshStandardMaterial({
  color: 0x3a4048,
  roughness: 0.78,
  metalness: 0.12,
});
const concreteMaterial = new THREE.MeshStandardMaterial({
  color: 0x6a7078,
  roughness: 0.9,
  metalness: 0.08,
});
const metalMaterial = new THREE.MeshStandardMaterial({
  color: 0x5a626c,
  roughness: 0.55,
  metalness: 0.42,
});
const windowGlow = new THREE.MeshStandardMaterial({
  color: 0xffd090,
  emissive: new THREE.Color(0xff9030),
  emissiveIntensity: 0.45,
  roughness: 0.4,
});

const localScratch = new THREE.Vector2();

function hash01(seed: number): number {
  const value = Math.sin(seed * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
  rotation?: THREE.Euler,
  scale?: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (rotation) {
    mesh.rotation.copy(rotation);
  }
  if (scale) {
    mesh.scale.copy(scale);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function buildCabin(): THREE.Group {
  const group = new THREE.Group();
  const wallHeight = 3.2;
  const width = 4.6;
  const depth = 3.8;

  addMesh(
    group,
    new THREE.BoxGeometry(width, wallHeight, 0.28),
    woodMaterial,
    new THREE.Vector3(0, wallHeight / 2, depth / 2),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(0.28, wallHeight, depth),
    woodMaterial,
    new THREE.Vector3(-width / 2, wallHeight / 2, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(0.28, wallHeight, depth),
    woodMaterial,
    new THREE.Vector3(width / 2, wallHeight / 2, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(width * 0.42, wallHeight, 0.28),
    woodMaterial,
    new THREE.Vector3(-width * 0.29, wallHeight / 2, -depth / 2),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(width * 0.42, wallHeight, 0.28),
    woodMaterial,
    new THREE.Vector3(width * 0.29, wallHeight / 2, -depth / 2),
  );

  const roof = addMesh(
    group,
    new THREE.ConeGeometry(width * 0.62, 1.35, 4),
    roofMaterial,
    new THREE.Vector3(0, wallHeight + 0.55, 0),
    new THREE.Euler(0, Math.PI / 4, 0),
  );
  roof.scale.set(1, 1, 0.82);

  addMesh(
    group,
    new THREE.PlaneGeometry(1.1, 2.05),
    woodTrim,
    new THREE.Vector3(0, 1.05, depth / 2 + 0.02),
  );
  addMesh(
    group,
    new THREE.PlaneGeometry(0.55, 0.7),
    windowGlow,
    new THREE.Vector3(-width * 0.22, 1.55, depth / 2 + 0.02),
  );

  return group;
}

function buildBunker(): THREE.Group {
  const group = new THREE.Group();
  const size = 4.2;
  const height = 2.4;

  addMesh(
    group,
    new THREE.BoxGeometry(size, height, size),
    concreteMaterial,
    new THREE.Vector3(0, height / 2, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(size * 0.95, 0.35, size * 0.95),
    concreteMaterial,
    new THREE.Vector3(0, height + 0.12, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(1.4, 0.55, 0.2),
    metalMaterial,
    new THREE.Vector3(0, 1.15, size / 2 + 0.02),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(0.9, 0.35, 0.18),
    new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.9 }),
    new THREE.Vector3(0, 1.05, size / 2 + 0.12),
  );

  return group;
}

function buildShed(): THREE.Group {
  const group = new THREE.Group();
  const width = 3.4;
  const depth = 2.8;
  const height = 2.6;

  addMesh(
    group,
    new THREE.BoxGeometry(width, height, 0.22),
    metalMaterial,
    new THREE.Vector3(0, height / 2, depth / 2),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(0.22, height, depth),
    metalMaterial,
    new THREE.Vector3(-width / 2, height / 2, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(0.22, height, depth),
    metalMaterial,
    new THREE.Vector3(width / 2, height / 2, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(width, height, 0.22),
    metalMaterial,
    new THREE.Vector3(0, height / 2, -depth / 2),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(width * 0.7, 0.18, depth * 0.72),
    roofMaterial,
    new THREE.Vector3(0, height + 0.08, 0),
  );

  return group;
}

function buildRuin(): THREE.Group {
  const group = new THREE.Group();
  addMesh(
    group,
    new THREE.BoxGeometry(0.35, 2.8, 3.6),
    concreteMaterial,
    new THREE.Vector3(-1.4, 1.4, 0),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(2.8, 2.2, 0.35),
    concreteMaterial,
    new THREE.Vector3(0.2, 1.1, -1.2),
  );
  addMesh(
    group,
    new THREE.BoxGeometry(0.35, 1.6, 2.2),
    concreteMaterial,
    new THREE.Vector3(1.5, 0.8, 0.8),
    new THREE.Euler(0, 0.4, 0),
  );
  addMesh(
    group,
    new THREE.DodecahedronGeometry(0.55, 0),
    concreteMaterial,
    new THREE.Vector3(0.6, 0.35, 0.4),
  );

  return group;
}

const BUILDERS: Record<BuildingKind, () => THREE.Group> = {
  cabin: buildCabin,
  bunker: buildBunker,
  shed: buildShed,
  ruin: buildRuin,
};

const BUILDING_SPECS: Record<
  BuildingKind,
  { outerRadius: number; doorHalfWidth: number; shelterRadius: number }
> = {
  cabin: { outerRadius: 2.55, doorHalfWidth: 0.75, shelterRadius: 3.1 },
  bunker: { outerRadius: 2.35, doorHalfWidth: 0.85, shelterRadius: 2.8 },
  shed: { outerRadius: 2.05, doorHalfWidth: 0.65, shelterRadius: 2.5 },
  ruin: { outerRadius: 2.15, doorHalfWidth: 1.4, shelterRadius: 2.4 },
};

const KIND_ROTATION: BuildingKind[] = ["cabin", "bunker", "shed", "ruin", "cabin", "shed", "bunker", "ruin", "cabin", "shed"];

function isTooCloseToPoints(x: number, z: number, points: ReadonlyArray<{ x: number; z: number }>, minDist: number): boolean {
  for (const point of points) {
    if (Math.hypot(x - point.x, z - point.z) < minDist) {
      return true;
    }
  }
  return false;
}

/** Scatter cabins, bunkers, sheds, and ruins across the arena. */
export function createArenaBuildings(
  parent: THREE.Group,
  avoidPoints: ReadonlyArray<{ x: number; z: number }> = [],
): ArenaBuilding[] {
  const buildings: ArenaBuilding[] = [];
  const placed: { x: number; z: number }[] = [...avoidPoints];
  const targetCount = KIND_ROTATION.length;

  for (let attempt = 0; attempt < targetCount * 20 && buildings.length < targetCount; attempt += 1) {
    const kind = KIND_ROTATION[buildings.length];
    const spec = BUILDING_SPECS[kind];
    const angle = hash01(attempt * 1.37 + buildings.length * 2.1) * Math.PI * 2;
    const radius =
      22 + hash01(attempt * 2.71) * (ARENA_RADIUS * 0.62) + hash01(attempt * 4.3) * 18;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    if (Math.hypot(x, z) < 14) {
      continue;
    }
    if (isTooCloseToPoints(x, z, placed, 11)) {
      continue;
    }
    if (isTooCloseToPoints(x, z, avoidPoints, 16)) {
      continue;
    }

    const yaw = hash01(attempt * 5.9) * Math.PI * 2;
    const groundY = sampleTerrainHeight(x, z);
    const root = BUILDERS[kind]();
    root.position.set(x, groundY, z);
    root.rotation.y = yaw;
    parent.add(root);

    const building: ArenaBuilding = {
      root,
      kind,
      x,
      z,
      yaw,
      outerRadius: spec.outerRadius,
      doorHalfWidth: spec.doorHalfWidth,
      shelterRadius: spec.shelterRadius,
    };
    buildings.push(building);
    placed.push({ x, z });
    registerBuildingShelter(x, z, spec.shelterRadius);
  }

  return buildings;
}

function worldToBuildingLocal(building: ArenaBuilding, worldX: number, worldZ: number): THREE.Vector2 {
  const dx = worldX - building.x;
  const dz = worldZ - building.z;
  const cos = Math.cos(-building.yaw);
  const sin = Math.sin(-building.yaw);
  localScratch.set(dx * cos - dz * sin, dx * sin + dz * cos);
  return localScratch;
}

function localToWorld(building: ArenaBuilding, localX: number, localZ: number, out: THREE.Vector2): THREE.Vector2 {
  const cos = Math.cos(building.yaw);
  const sin = Math.sin(building.yaw);
  out.set(
    building.x + localX * cos - localZ * sin,
    building.z + localX * sin + localZ * cos,
  );
  return out;
}

/** Push the player out of building walls while allowing doorway entry. */
export function resolveBuildingCollision(
  buildings: ArenaBuilding[],
  worldX: number,
  worldZ: number,
  out: THREE.Vector2,
): THREE.Vector2 {
  out.set(worldX, worldZ);

  for (const building of buildings) {
    const local = worldToBuildingLocal(building, out.x, out.y);
    const dist = local.length();
    if (dist < 0.25) {
      continue;
    }

    const inDoorway = local.y > 0.2 && Math.abs(local.x) < building.doorHalfWidth;
    if (inDoorway || dist > building.outerRadius + 0.35) {
      continue;
    }

    if (dist < building.outerRadius + 0.35) {
      const push = (building.outerRadius + 0.35 - dist) / dist;
      local.multiplyScalar(1 + push);
      localToWorld(building, local.x, local.y, out);
    }
  }

  return out;
}

export function pushEnemyAwayFromBuildings(
  buildings: ArenaBuilding[],
  worldX: number,
  worldZ: number,
  out: THREE.Vector2,
): THREE.Vector2 {
  out.set(worldX, worldZ);
  for (const building of buildings) {
    const dx = out.x - building.x;
    const dz = out.y - building.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.001 && dist < building.outerRadius + 0.2) {
      const push = (building.outerRadius + 0.2 - dist) / dist;
      out.x += dx * push;
      out.y += dz * push;
    }
  }
  return out;
}
