import type { LootTower } from "./lootTowers";
import { findTowerPlayerIsInside, isPlayerUnderTowerRoof } from "./lootTowers";

export type TreeShelter = {
  x: number;
  z: number;
  radius: number;
};

const treeShelters: TreeShelter[] = [];
const buildingShelters: TreeShelter[] = [];

export function clearTreeShelters(): void {
  treeShelters.length = 0;
}

export function clearBuildingShelters(): void {
  buildingShelters.length = 0;
}

export function registerBuildingShelter(x: number, z: number, radius = 3): void {
  buildingShelters.push({ x, z, radius });
}

export function registerTreeShelter(x: number, z: number, radius = 2.5): void {
  treeShelters.push({ x, z, radius });
}

/** True when the player is under a tower roof or tree canopy. */
export function isPlayerUnderShelter(
  towers: LootTower[],
  worldX: number,
  worldZ: number,
): boolean {
  if (findTowerPlayerIsInside(towers, worldX, worldZ)) {
    return true;
  }

  for (const tower of towers) {
    if (isPlayerUnderTowerRoof(tower, worldX, worldZ)) {
      return true;
    }
  }

  for (const tree of treeShelters) {
    const dist = Math.hypot(tree.x - worldX, tree.z - worldZ);
    if (dist < tree.radius) {
      return true;
    }
  }

  for (const building of buildingShelters) {
    const dist = Math.hypot(building.x - worldX, building.z - worldZ);
    if (dist < building.radius) {
      return true;
    }
  }

  return false;
}
