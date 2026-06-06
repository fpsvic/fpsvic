import * as THREE from "three";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";
import { getWeaponByIndex, TOWER_WEAPON_INDICES, type Weapon } from "./weapons";

export type LootTower = {
  root: THREE.Group;
  lootAnchor: THREE.Object3D;
  weapon: Weapon;
  weaponIndex: number;
  looted: boolean;
};

const TOWER_LAYOUT = [4, 5, 6, 5, 4, 6] as const;

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

function buildTowerMesh(groundY: number): { tower: THREE.Group; lootAnchor: THREE.Object3D } {
  const tower = new THREE.Group();
  tower.position.y = groundY;

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.4, 7.2, 8), stoneMaterial);
  shaft.position.y = 3.6;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  tower.add(shaft);

  const deck = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.2, 0.55, 8), trimMaterial);
  deck.position.y = 7.45;
  deck.castShadow = true;
  tower.add(deck);

  for (let index = 0; index < 4; index += 1) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI * 0.25;
    const crenel = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.85, 0.75), trimMaterial);
    crenel.position.set(Math.cos(angle) * 3.1, 8.05, Math.sin(angle) * 3.1);
    crenel.rotation.y = -angle;
    crenel.castShadow = true;
    tower.add(crenel);
  }

  const door = new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.2, 0.2), trimMaterial);
  door.position.set(0, 1.15, 3.25);
  tower.add(door);

  const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 1.05), windowMaterial);
  windowMesh.position.set(0, 4.6, 3.26);
  tower.add(windowMesh);

  const banner = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.9), bannerMaterial);
  banner.position.set(2.2, 5.8, 2.85);
  banner.rotation.y = -0.45;
  tower.add(banner);

  const lootAnchor = new THREE.Object3D();
  lootAnchor.position.set(0, 7.95, 0);
  tower.add(lootAnchor);

  const beacon = new THREE.PointLight(0xffc070, 0.85, 14, 2);
  beacon.position.set(0, 8.2, 0);
  tower.add(beacon);

  return { tower, lootAnchor };
}

/** Stone loot towers scattered across the arena. */
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

    const { tower: root, lootAnchor } = buildTowerMesh(groundY);
    root.position.set(x, 0, z);
    root.rotation.y = -angle + Math.PI;
    parent.add(root);

    towers.push({
      root,
      lootAnchor,
      weapon,
      weaponIndex,
      looted: false,
    });
  }

  return towers;
}

export function getTowerLootWorldPosition(tower: LootTower, target: THREE.Vector3): THREE.Vector3 {
  return tower.lootAnchor.getWorldPosition(target);
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
    const dx = tower.root.position.x - playerX;
    const dz = tower.root.position.z - playerZ;
    const dist = Math.hypot(dx, dz);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = tower;
    }
  }

  return nearest;
}

