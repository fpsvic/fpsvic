import * as THREE from "three";

export type HumanoidPalette = {
  skin: THREE.Material;
  shirt: THREE.Material;
  pants: THREE.Material;
  boots: THREE.Material;
  hair?: THREE.Material;
};

export type HumanoidRig = {
  root: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  weaponMount: THREE.Group;
};

const limbGeometries = {
  torso: new THREE.CapsuleGeometry(0.26, 0.5, 8, 16),
  pelvis: new THREE.BoxGeometry(0.42, 0.16, 0.22),
  belt: new THREE.BoxGeometry(0.44, 0.07, 0.26),
  head: new THREE.SphereGeometry(0.135, 20, 16),
  neck: new THREE.CapsuleGeometry(0.055, 0.06, 6, 12),
  upperArm: new THREE.CapsuleGeometry(0.055, 0.24, 6, 12),
  lowerArm: new THREE.CapsuleGeometry(0.045, 0.2, 6, 12),
  upperLeg: new THREE.CapsuleGeometry(0.075, 0.34, 6, 12),
  lowerLeg: new THREE.CapsuleGeometry(0.062, 0.3, 6, 12),
  shoulder: new THREE.SphereGeometry(0.09, 10, 10),
  hand: new THREE.BoxGeometry(0.08, 0.055, 0.09),
  foot: new THREE.BoxGeometry(0.12, 0.06, 0.26),
  eye: new THREE.SphereGeometry(0.018, 8, 8),
  hair: new THREE.SphereGeometry(0.145, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
};

const eyeMaterial = new THREE.MeshStandardMaterial({
  color: 0x1a1410,
  roughness: 0.35,
  metalness: 0.05,
});

const scleraMaterial = new THREE.MeshStandardMaterial({
  color: 0xf2ebe4,
  roughness: 0.4,
  metalness: 0,
});

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: THREE.Vector3,
  castShadow: boolean,
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
  mesh.castShadow = castShadow;
  mesh.receiveShadow = castShadow;
  parent.add(mesh);
  return mesh;
}

function buildLeg(
  parent: THREE.Group,
  side: number,
  palette: HumanoidPalette,
  castShadow: boolean,
): THREE.Group {
  const leg = new THREE.Group();
  leg.position.set(0.11 * side, 0.9, 0);
  parent.add(leg);

  const upper = addMesh(
    leg,
    limbGeometries.upperLeg,
    palette.pants,
    new THREE.Vector3(0, -0.2, 0),
    castShadow,
  );
  upper.rotation.x = 0.06;
  upper.rotation.z = side * 0.04;

  const lowerGroup = new THREE.Group();
  lowerGroup.position.set(0, -0.4, 0);
  leg.add(lowerGroup);

  addMesh(
    lowerGroup,
    limbGeometries.lowerLeg,
    palette.pants,
    new THREE.Vector3(0, -0.17, 0),
    castShadow,
  );
  addMesh(
    lowerGroup,
    limbGeometries.foot,
    palette.boots,
    new THREE.Vector3(0, -0.38, 0.05),
    castShadow,
    undefined,
    new THREE.Vector3(1, 0.95, 1.05),
  );

  leg.userData.lower = lowerGroup;
  return leg;
}

function buildArm(
  parent: THREE.Group,
  side: number,
  palette: HumanoidPalette,
  castShadow: boolean,
): { arm: THREE.Group; mount: THREE.Group } {
  const arm = new THREE.Group();
  arm.position.set(0.27 * side, 1.36, 0);
  parent.add(arm);

  addMesh(arm, limbGeometries.upperArm, palette.shirt, new THREE.Vector3(0, -0.16, 0), castShadow);

  const lowerGroup = new THREE.Group();
  lowerGroup.position.set(0, -0.32, 0);
  arm.add(lowerGroup);

  addMesh(
    lowerGroup,
    limbGeometries.lowerArm,
    palette.skin,
    new THREE.Vector3(0, -0.12, 0),
    castShadow,
  );
  addMesh(
    lowerGroup,
    limbGeometries.hand,
    palette.skin,
    new THREE.Vector3(0, -0.28, 0.01),
    castShadow,
  );

  const mount = new THREE.Group();
  mount.position.set(0, -0.3, 0.03);
  lowerGroup.add(mount);

  arm.userData.lower = lowerGroup;
  return { arm, mount };
}

function buildHead(
  hips: THREE.Group,
  palette: HumanoidPalette,
  castShadow: boolean,
): THREE.Mesh {
  const head = addMesh(
    hips,
    limbGeometries.head,
    palette.skin,
    new THREE.Vector3(0, 1.78, 0),
    castShadow,
    undefined,
    new THREE.Vector3(0.98, 1.04, 0.94),
  );

  addMesh(
    head,
    limbGeometries.eye,
    scleraMaterial,
    new THREE.Vector3(-0.042, 0.02, 0.118),
    false,
  );
  addMesh(
    head,
    limbGeometries.eye,
    scleraMaterial,
    new THREE.Vector3(0.042, 0.02, 0.118),
    false,
  );
  addMesh(
    head,
    limbGeometries.eye,
    eyeMaterial,
    new THREE.Vector3(-0.042, 0.018, 0.132),
    false,
    undefined,
    new THREE.Vector3(0.75, 1, 0.6),
  );
  addMesh(
    head,
    limbGeometries.eye,
    eyeMaterial,
    new THREE.Vector3(0.042, 0.018, 0.132),
    false,
    undefined,
    new THREE.Vector3(0.75, 1, 0.6),
  );

  const browMat = palette.hair ?? palette.skin;
  addMesh(
    head,
    new THREE.BoxGeometry(0.11, 0.018, 0.04),
    browMat,
    new THREE.Vector3(-0.042, 0.055, 0.125),
    castShadow,
  );
  addMesh(
    head,
    new THREE.BoxGeometry(0.11, 0.018, 0.04),
    browMat,
    new THREE.Vector3(0.042, 0.055, 0.125),
    castShadow,
  );

  if (palette.hair) {
    const hair = addMesh(
      head,
      limbGeometries.hair,
      palette.hair,
      new THREE.Vector3(0, 0.1, -0.02),
      castShadow,
    );
    hair.scale.set(1.02, 0.92, 1.05);
  }

  return head;
}

export function createHumanoid(
  palette: HumanoidPalette,
  scale: number,
  castShadow: boolean,
): HumanoidRig {
  const root = new THREE.Group();
  root.scale.setScalar(scale);

  const hips = new THREE.Group();
  hips.position.y = 0.02;
  root.add(hips);

  addMesh(hips, limbGeometries.pelvis, palette.pants, new THREE.Vector3(0, 1.02, 0), castShadow);
  addMesh(hips, limbGeometries.belt, palette.boots, new THREE.Vector3(0, 1.08, 0), castShadow);

  const torso = addMesh(
    hips,
    limbGeometries.torso,
    palette.shirt,
    new THREE.Vector3(0, 1.22, 0),
    castShadow,
  );
  torso.rotation.x = -0.04;

  addMesh(hips, limbGeometries.shoulder, palette.shirt, new THREE.Vector3(-0.3, 1.42, 0), castShadow);
  addMesh(hips, limbGeometries.shoulder, palette.shirt, new THREE.Vector3(0.3, 1.42, 0), castShadow);

  addMesh(hips, limbGeometries.neck, palette.skin, new THREE.Vector3(0, 1.58, 0), castShadow);
  const head = buildHead(hips, palette, castShadow);

  const leftLeg = buildLeg(hips, -1, palette, castShadow);
  const rightLeg = buildLeg(hips, 1, palette, castShadow);
  const leftArmData = buildArm(hips, -1, palette, castShadow);
  const rightArmData = buildArm(hips, 1, palette, castShadow);

  return {
    root,
    hips,
    torso,
    head,
    leftArm: leftArmData.arm,
    rightArm: rightArmData.arm,
    leftLeg,
    rightLeg,
    weaponMount: rightArmData.mount,
  };
}

/** Forward slash / charge wind-up pose (camera-facing attacks). */
export function applyAttackPose(
  rig: HumanoidRig,
  swingPhase: number,
  chargeRatio: number,
  charged: boolean,
): void {
  const sweep = Math.sin(Math.min(1, swingPhase) * Math.PI);
  const wind = chargeRatio * (charged ? 1.15 : 1);
  const power = charged ? 1.35 : 1;

  rig.torso.rotation.x = -0.12 - sweep * 0.72 * power - wind * 0.48;
  rig.rightArm.rotation.x = -0.45 - sweep * 2.35 * power - wind * 1.05;
  rig.leftArm.rotation.x = sweep * 0.35 + wind * 0.12;

  const rightLower = rig.rightArm.userData.lower as THREE.Group;
  const leftLower = rig.leftArm.userData.lower as THREE.Group;
  rightLower.rotation.x = -0.3 - sweep * 1.35 * power - wind * 0.5;
  leftLower.rotation.x = -0.22 - Math.abs(sweep) * 0.25;

  rig.hips.position.z = sweep * 0.28 * power + wind * 0.06;
  rig.hips.position.y = 0.02 + sweep * 0.04;
}

export function animateHumanoid(
  rig: HumanoidRig,
  speed: number,
  phase: number,
  attackSwing: number,
): void {
  rig.hips.position.z = 0;
  rig.torso.rotation.x = 0;

  const moveAmount = THREE.MathUtils.clamp(speed / 5.5, 0, 1);
  const stride = Math.sin(phase) * 0.55 * moveAmount;
  const armStride = Math.sin(phase + Math.PI) * 0.42 * moveAmount;

  const leftLower = rig.leftLeg.userData.lower as THREE.Group;
  const rightLower = rig.rightLeg.userData.lower as THREE.Group;
  const leftArmLower = rig.leftArm.userData.lower as THREE.Group;
  const rightArmLower = rig.rightArm.userData.lower as THREE.Group;

  rig.leftLeg.rotation.x = stride;
  rig.rightLeg.rotation.x = -stride;
  leftLower.rotation.x = Math.max(0, -stride * 0.85);
  rightLower.rotation.x = Math.max(0, stride * 0.85);

  rig.leftArm.rotation.x = armStride;
  rig.rightArm.rotation.x = -armStride + attackSwing * 1.4;
  leftArmLower.rotation.x = -0.25 - Math.abs(armStride) * 0.35;
  rightArmLower.rotation.x = -0.25 - attackSwing * 0.8;

  const bob = Math.abs(Math.sin(phase * 2)) * 0.035 * moveAmount;
  rig.hips.position.y = 0.02 + bob;
  rig.torso.rotation.x = bob * 0.45;
  rig.head.position.y = 1.78 + bob * 0.25;
}

export function setHumanoidFlash(
  rig: HumanoidRig,
  palette: HumanoidPalette,
  flashing: boolean,
): void {
  void rig;
  const materials = [palette.skin, palette.shirt, palette.pants, palette.boots];
  if (palette.hair) {
    materials.push(palette.hair);
  }
  for (const material of materials) {
    const mat = material as THREE.MeshPhysicalMaterial;
    mat.transparent = flashing;
    mat.opacity = flashing ? 0.52 : 1;
    if (!flashing) {
      mat.transparent = false;
      mat.opacity = 1;
    }
  }
}
