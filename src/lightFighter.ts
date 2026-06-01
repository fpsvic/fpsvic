import * as THREE from "three";

export type FighterMaterials = {
  body: THREE.Material;
  head: THREE.Material;
};

export type LightFighter = {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  leftShoulder: THREE.Mesh;
  rightShoulder: THREE.Mesh;
};

const bodyGeometry = new THREE.CapsuleGeometry(0.38, 0.88, 6, 10);
const headGeometry = new THREE.SphereGeometry(0.14, 10, 8);
const shoulderGeometry = new THREE.SphereGeometry(0.1, 6, 6);

export function createLightFighter(
  materials: FighterMaterials,
  scale: number,
): LightFighter {
  const root = new THREE.Group();
  root.scale.setScalar(scale);

  const body = new THREE.Mesh(bodyGeometry, materials.body);
  body.position.y = 0.92 * scale;
  root.add(body);

  const head = new THREE.Mesh(headGeometry, materials.head);
  head.position.y = 1.62 * scale;
  root.add(head);

  const leftShoulder = new THREE.Mesh(shoulderGeometry, materials.body);
  leftShoulder.position.set(-0.22 * scale, 1.38 * scale, 0);
  root.add(leftShoulder);

  const rightShoulder = new THREE.Mesh(shoulderGeometry, materials.body);
  rightShoulder.position.set(0.22 * scale, 1.38 * scale, 0);
  root.add(rightShoulder);

  return { root, body, head, leftShoulder, rightShoulder };
}

export function animateLightFighter(
  fighter: LightFighter,
  speed: number,
  phase: number,
): void {
  const move = THREE.MathUtils.clamp(speed / 5, 0, 1);
  const bob = Math.sin(phase * 2) * 0.04 * move;
  fighter.body.position.y = 0.92 * fighter.root.scale.x + bob;
  fighter.head.position.y = 1.62 * fighter.root.scale.x + bob * 1.2;
  fighter.leftShoulder.position.y = 1.38 * fighter.root.scale.x + bob * 0.9;
  fighter.rightShoulder.position.y = 1.38 * fighter.root.scale.x + bob * 0.9;
  fighter.body.rotation.x = Math.sin(phase) * 0.08 * move;
}
