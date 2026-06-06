import * as THREE from "three";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";
import { getWeaponByIndex, TOWER_WEAPON_INDICES, type Weapon } from "./weapons";

export type LootTower = {
  root: THREE.Group;
  lootAnchor: THREE.Object3D;
  weapon: Weapon;
  weaponIndex: number;
  looted: boolean;
  groundY: number;
};

const TOWER_LAYOUT = [4, 5, 6, 5, 4, 6] as const;
const INTERIOR_RADIUS = 2.45;
const WALL_RADIUS = 3.35;

const stoneMaterial = new THREE.MeshStandardMaterial({
  color: 0x6a7588,
  roughness: 0.82,
  metalness: 0.12,
});
const trimMaterial = new THREE.MeshStandardMaterial({
  color: 0x4a5568,
  roughness: 0.7,
  metalness: 0.2,
});
const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0x5a6578,
  roughness: 0.88,
  metalness: 0.08,
});
const windowMaterial = new THREE.MeshStandardMaterial({
  color: 0xffd48a,
  emissive: new THREE.Color(0xffa040),
  emissiveIntensity: 0.55,
  roughness: 0.4,
  metalness: 0.05,
});
const bannerMaterial = new THREE.MeshStandardMaterial({
  color: 0x8b3a4a,
  roughness: 0.75,
  emissive: new THREE.Color(0x401018),
  emissiveIntensity: 0.15,
});
const chestMaterial = new THREE.MeshStandardMaterial({
  color: 0x8a5a28,
  roughness: 0.55,
  metalness: 0.25,
  emissive: new THREE.Color(0x402008),
  emissiveIntensity: 0.12,
});

const localPlayer = new THREE.Vector2();

function buildTowerMesh(): { tower: THREE.Group; lootAnchor: THREE.Object3D } {
  const tower = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.CircleGeometry(INTERIOR_RADIUS, 16), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.04;
  floor.receiveShadow = true;
  tower.add(floor);

  const wallHeight = 5.2;
  const wallThickness = 0.85;
  const doorWidth = 2.1;
  const sideWallDepth = WALL_RADIUS * 2 - doorWidth;

  const leftWall = new THREE.Mesh(
    new THREE.BoxGeometry(wallThickness, wallHeight, sideWallDepth),
    stoneMaterial,
  );
  leftWall.position.set(-(doorWidth / 2 + sideWallDepth / 2), wallHeight / 2, -0.35);
  leftWall.castShadow = true;
  leftWall.receiveShadow = true;
  tower.add(leftWall);

  const rightWall = new THREE.Mesh(
    new THREE.BoxGeometry(wallThickness, wallHeight, sideWallDepth),
    stoneMaterial,
  );
  rightWall.position.set(doorWidth / 2 + sideWallDepth / 2, wallHeight / 2, -0.35);
  rightWall.castShadow = true;
  rightWall.receiveShadow = true;
  tower.add(rightWall);

  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(doorWidth + wallThickness * 2, wallHeight, wallThickness),
    stoneMaterial,
  );
  backWall.position.set(0, wallHeight / 2, -(WALL_RADIUS - 0.2));
  backWall.castShadow = true;
  tower.add(backWall);

  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorWidth + 0.4, 0.55, 0.65), trimMaterial);
  lintel.position.set(0, 2.55, WALL_RADIUS - 0.55);
  tower.add(lintel);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.45, 7.4), trimMaterial);
  deck.position.y = wallHeight + 0.2;
  deck.castShadow = true;
  tower.add(deck);

  for (let index = 0; index < 4; index += 1) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI * 0.25;
    const crenel = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.75, 0.65), trimMaterial);
    crenel.position.set(Math.cos(angle) * 3.35, wallHeight + 0.55, Math.sin(angle) * 3.35 - 0.35);
    crenel.rotation.y = -angle;
    crenel.castShadow = true;
    tower.add(crenel);
  }

  const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.95), windowMaterial);
  windowMesh.position.set(-1.55, 3.1, WALL_RADIUS - 0.52);
  tower.add(windowMesh);

  const banner = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 0.8), bannerMaterial);
  banner.position.set(1.65, 3.8, WALL_RADIUS - 0.85);
  banner.rotation.y = -0.35;
  tower.add(banner);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.62, 0.62), chestMaterial);
  chest.position.set(0, 0.35, -0.35);
  chest.castShadow = true;
  tower.add(chest);

  const lootAnchor = new THREE.Object3D();
  lootAnchor.position.set(0, 0.95, -0.35);
  tower.add(lootAnchor);

  const beacon = new THREE.PointLight(0xffc070, 0.7, 10, 2);
  beacon.position.set(0, 2.4, 0);
  tower.add(beacon);

  return { tower, lootAnchor };
}

/** Stone loot towers with walk-in interiors and ground-floor chest loot. */
export function createLootTowers(parent: THREE.Group): LootTower[] {
  const towers: LootTower[] = [];
  const count = TOWER_LAYOUT.length;

  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + 0.22;
    const radius = ARENA_RADIUS * (0.38 + (index % 3) * 0.14) + (index % 2) * 8;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const groundY = sampleTerrainHeight(x, z);
    const weaponIndex = TOWER_LAYOUT[index] ?? TOWER_WEAPON_INDICES[0];
    const weapon = getWeaponByIndex(weaponIndex);

    const { tower: root, lootAnchor } = buildTowerMesh();
    root.position.set(x, groundY, z);
    root.rotation.y = -angle + Math.PI;
    parent.add(root);

    towers.push({
      root,
      lootAnchor,
      weapon,
      weaponIndex,
      looted: false,
      groundY,
    });
  }

  return towers;
}

export function getTowerLootWorldPosition(tower: LootTower, target: THREE.Vector3): THREE.Vector3 {
  return tower.lootAnchor.getWorldPosition(target);
}

const doorScratch = new THREE.Vector3();

export function getTowerDoorWorldPosition(tower: LootTower, target: THREE.Vector3): THREE.Vector3 {
  target.set(0, 0.05, WALL_RADIUS - 0.15);
  return tower.root.localToWorld(target);
}

/** Player position in tower-local XZ (door faces +Z). */
export function getTowerLocalXZ(
  tower: LootTower,
  worldX: number,
  worldZ: number,
  target: THREE.Vector2,
): THREE.Vector2 {
  const dx = worldX - tower.root.position.x;
  const dz = worldZ - tower.root.position.z;
  const yaw = -tower.root.rotation.y;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  target.set(dx * cos - dz * sin, dx * sin + dz * cos);
  return target;
}

export function isPlayerInsideTower(
  tower: LootTower,
  worldX: number,
  worldZ: number,
): boolean {
  const local = getTowerLocalXZ(tower, worldX, worldZ, localPlayer);
  if (local.y < -0.85) {
    return false;
  }
  return local.length() < INTERIOR_RADIUS + 0.15;
}

export function findTowerPlayerIsInside(
  towers: LootTower[],
  worldX: number,
  worldZ: number,
): LootTower | null {
  for (const tower of towers) {
    if (tower.looted) {
      continue;
    }
    if (isPlayerInsideTower(tower, worldX, worldZ)) {
      return tower;
    }
  }
  return null;
}

export function findNearestTower(
  towers: LootTower[],
  playerX: number,
  playerZ: number,
  maxDistance: number,
): LootTower | null {
  let nearest: LootTower | null = null;
  let nearestDist = maxDistance;

  for (const tower of towers) {
    if (tower.looted) {
      continue;
    }
    getTowerDoorWorldPosition(tower, doorScratch);
    const dist = Math.hypot(doorScratch.x - playerX, doorScratch.z - playerZ);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = tower;
    }
  }

  return nearest;
}

/** Keep the player out of tower walls but allow walking through the door. */
export function resolveTowerWallCollision(
  towers: LootTower[],
  playerX: number,
  playerZ: number,
  out: THREE.Vector2,
): THREE.Vector2 {
  out.set(playerX, playerZ);

  for (const tower of towers) {
    const local = getTowerLocalXZ(tower, out.x, out.y, localPlayer);
    const dist = local.length();

    if (dist < 0.35) {
      continue;
    }

    const insideInterior = dist < INTERIOR_RADIUS + 0.08;
    const inDoorway = local.y > 0.55 && Math.abs(local.x) < 1.15;
    if (insideInterior || inDoorway) {
      continue;
    }

    if (dist < WALL_RADIUS + 0.55) {
      const push = (WALL_RADIUS + 0.55 - dist) / dist;
      local.x *= 1 + push;
      local.y *= 1 + push;
      const yaw = tower.root.rotation.y;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      out.x = tower.root.position.x + local.x * cos - local.y * sin;
      out.y = tower.root.position.z + local.x * sin + local.y * cos;
    }
  }

  return out;
}
