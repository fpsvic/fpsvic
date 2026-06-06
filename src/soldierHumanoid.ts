import * as THREE from "three";
import { createHumanoid, type HumanoidRig } from "./humanoid";
import { collectSoldierFlashMaterials, createSoldierPalette, type SoldierPalette } from "./soldierMaterials";

const gearGeometries = {
  beret: new THREE.SphereGeometry(0.152, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
  beretBrim: new THREE.CylinderGeometry(0.155, 0.16, 0.018, 16, 1, false, 0, Math.PI),
  emblem: new THREE.CylinderGeometry(0.018, 0.018, 0.008, 8),
  vest: new THREE.BoxGeometry(0.54, 0.42, 0.3),
  pouch: new THREE.BoxGeometry(0.1, 0.12, 0.06),
  backpack: new THREE.BoxGeometry(0.38, 0.48, 0.22),
  molleStrap: new THREE.BoxGeometry(0.04, 0.14, 0.025),
  holster: new THREE.BoxGeometry(0.08, 0.14, 0.07),
  antenna: new THREE.CylinderGeometry(0.008, 0.008, 0.42, 6),
  pistolGrip: new THREE.BoxGeometry(0.035, 0.08, 0.05),
};

function addGearMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
  rotation?: THREE.Euler,
  scale?: THREE.Vector3,
  castShadow = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (rotation) {
    mesh.rotation.copy(rotation);
  }
  if (scale) {
    mesh.scale.copy(scale);
  }
  mesh.castShadow = castShadow;
  mesh.receiveShadow = castShadow;
  parent.add(mesh);
  return mesh;
}

function attachSoldierGear(rig: HumanoidRig, palette: SoldierPalette, castShadow: boolean): void {
  const { hips, head, torso, rightLeg } = rig;

  const beret = addGearMesh(
    head,
    gearGeometries.beret,
    palette.beret,
    new THREE.Vector3(0.02, 0.12, -0.01),
    new THREE.Euler(0, 0.15, 0.22),
    new THREE.Vector3(1.05, 0.82, 1.02),
    castShadow,
  );
  beret.renderOrder = 1;

  addGearMesh(
    head,
    gearGeometries.beretBrim,
    palette.beret,
    new THREE.Vector3(0.03, 0.04, 0.02),
    new THREE.Euler(0.1, 0.2, 0.18),
    undefined,
    castShadow,
  );

  addGearMesh(
    head,
    gearGeometries.emblem,
    palette.emblem,
    new THREE.Vector3(0.04, 0.1, 0.128),
    new THREE.Euler(Math.PI / 2, 0.2, 0.15),
    undefined,
    castShadow,
  );

  const vest = addGearMesh(
    hips,
    gearGeometries.vest,
    palette.vest,
    new THREE.Vector3(0, 1.24, 0.02),
    new THREE.Euler(-0.04, 0, 0),
    new THREE.Vector3(1.02, 1, 1.05),
    castShadow,
  );
  vest.renderOrder = 1;

  const pouchOffsets = [
    new THREE.Vector3(-0.16, 1.18, 0.16),
    new THREE.Vector3(0, 1.16, 0.17),
    new THREE.Vector3(0.16, 1.18, 0.16),
    new THREE.Vector3(-0.08, 1.06, 0.165),
    new THREE.Vector3(0.08, 1.06, 0.165),
  ];
  for (const offset of pouchOffsets) {
    addGearMesh(
      hips,
      gearGeometries.pouch,
      palette.gear,
      offset,
      new THREE.Euler(-0.04, 0, 0),
      undefined,
      castShadow,
    );
  }

  const backpack = addGearMesh(
    hips,
    gearGeometries.backpack,
    palette.gear,
    new THREE.Vector3(0, 1.28, -0.2),
    new THREE.Euler(-0.06, 0, 0),
    new THREE.Vector3(1, 1.05, 1),
    castShadow,
  );
  backpack.renderOrder = -1;

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      addGearMesh(
        backpack,
        gearGeometries.molleStrap,
        palette.vest,
        new THREE.Vector3(-0.1 + col * 0.2, 0.08 - row * 0.14, 0.115),
        undefined,
        undefined,
        castShadow,
      );
    }
  }

  addGearMesh(
    backpack,
    gearGeometries.antenna,
    palette.emblem,
    new THREE.Vector3(0.12, 0.28, 0.02),
    new THREE.Euler(0.08, 0, 0.12),
    undefined,
    castShadow,
  );

  const rightLower = rightLeg.userData.lower as THREE.Group;
  addGearMesh(
    rightLower,
    gearGeometries.holster,
    palette.gear,
    new THREE.Vector3(0.1, -0.22, 0.04),
    new THREE.Euler(0, -0.2, 0.05),
    undefined,
    castShadow,
  );
  addGearMesh(
    rightLower,
    gearGeometries.pistolGrip,
    palette.boots,
    new THREE.Vector3(0.1, -0.2, 0.1),
    new THREE.Euler(0.2, -0.15, 0.1),
    undefined,
    castShadow,
  );

  torso.material = palette.vest;
}

export function createSoldierHumanoid(
  scale: number,
  castShadow: boolean,
  palette: SoldierPalette = createSoldierPalette(),
): { rig: HumanoidRig; palette: SoldierPalette } {
  const rig = createHumanoid(palette, scale, castShadow);
  attachSoldierGear(rig, palette, castShadow);
  return { rig, palette };
}

export function setSoldierFlash(palette: SoldierPalette, flashing: boolean): void {
  for (const material of collectSoldierFlashMaterials(palette)) {
    const mat = material as THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
    mat.transparent = flashing;
    mat.opacity = flashing ? 0.52 : 1;
    if (!flashing) {
      mat.transparent = false;
      mat.opacity = 1;
    }
  }
}
