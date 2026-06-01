import * as THREE from "three";
import {
  animateHumanoid,
  applyAttackPose,
  createHumanoid,
  setHumanoidFlash,
  type HumanoidPalette,
  type HumanoidRig,
} from "./humanoid";
import { createArenaTerrain, sampleTerrainHeight } from "./terrain";
import "./styles.css";

const ARENA_RADIUS = 90;
const ATTACK_CHARGE_TIME = 2;
const CHARGED_DAMAGE_MULTIPLIER = 2.85;
const CHARGED_RANGE_MULTIPLIER = 1.22;
const CHARGED_KNOCKBACK_MULTIPLIER = 1.65;

type GameState = "start" | "playing" | "ended";

type Weapon = {
  name: string;
  damage: number;
  range: number;
  arc: number;
  cooldown: number;
  knockback: number;
  color: THREE.ColorRepresentation;
  bladeLength: number;
  handleLength: number;
};

type Enemy = {
  group: THREE.Group;
  humanoid: HumanoidRig;
  walkPhase: number;
  health: number;
  maxHealth: number;
  speed: number;
  radius: number;
  cooldown: number;
  stun: number;
};

type Pickup = {
  group: THREE.Group;
  weapon: Weapon;
  bobOffset: number;
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Unable to find app container.");
}

const weapons: Weapon[] = [
  {
    name: "Storm Knife",
    damage: 26,
    range: 2.0,
    arc: Math.PI * 0.56,
    cooldown: 0.34,
    knockback: 2.6,
    color: 0x9eb4c2,
    bladeLength: 0.9,
    handleLength: 0.42,
  },
  {
    name: "Knight Sword",
    damage: 42,
    range: 2.8,
    arc: Math.PI * 0.48,
    cooldown: 0.62,
    knockback: 3.8,
    color: 0xb8c4d0,
    bladeLength: 1.55,
    handleLength: 0.55,
  },
  {
    name: "Raider Axe",
    damage: 58,
    range: 2.45,
    arc: Math.PI * 0.42,
    cooldown: 0.9,
    knockback: 5.2,
    color: 0x8a7560,
    bladeLength: 1.15,
    handleLength: 0.95,
  },
  {
    name: "Crystal Spear",
    damage: 34,
    range: 3.8,
    arc: Math.PI * 0.28,
    cooldown: 0.7,
    knockback: 4.4,
    color: 0xa8b8d8,
    bladeLength: 2.0,
    handleLength: 0.9,
  },
];

const scene = new THREE.Scene();
const horizonColor = new THREE.Color(0xa8c0d8);
scene.background = horizonColor.clone();
scene.fog = new THREE.Fog(horizonColor.getHex(), 42, 130);

const camera = new THREE.PerspectiveCamera(
  58,
  window.innerWidth / window.innerHeight,
  0.1,
  320,
);
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);

const hud = document.createElement("div");
hud.className = "hud";
hud.innerHTML = `
  <div class="top-bar">
    <div class="stat"><span>Health</span><strong data-health>100</strong></div>
    <div class="stat"><span>Alive</span><strong data-alive>12</strong></div>
    <div class="stat"><span>Elims</span><strong data-score>0</strong></div>
    <div class="stat"><span>Storm</span><strong data-storm>90m</strong></div>
  </div>

  <div class="weapon-card">
    <div class="weapon-name" data-weapon-name>Storm Knife</div>
    <div class="weapon-info" data-weapon-info>Fast starter blade.</div>
    <div class="cooldown-wrap"><div class="cooldown-bar" data-cooldown></div></div>
    <div class="charge-wrap"><div class="charge-bar" data-charge></div></div>
    <div class="health-wrap"><div class="health-bar" data-health-bar></div></div>
  </div>

  <div class="bottom-bar">
    <div class="controls">
      <div><kbd>RMB</kbd> move to point</div>
      <div><kbd>Drag LMB</kbd> rotate camera</div>
      <div><kbd>A</kbd> slash / hold 2s charge</div>
      <div><kbd>Space</kbd> dash</div>
      <div><kbd>E</kbd> pick up</div>
      <div><kbd>R</kbd> restart</div>
    </div>
  </div>

  <div class="center-message hidden" data-message></div>

  <div class="start-panel" data-start-panel>
    <h1>Blade Drop Arena</h1>
    <p>Drop into a grounded 3D battle arena where every fight is close range. Outlast the bots, loot stronger knives, swords, axes, and spears, and stay inside the shrinking storm ring.</p>
    <button data-start-button>Start match</button>
  </div>

  <div class="end-panel hidden" data-end-panel>
    <h2 data-end-title>Match over</h2>
    <p data-end-copy></p>
    <button data-restart-button>Play again</button>
  </div>
`;
app.appendChild(hud);

function requireHudElement<T extends HTMLElement>(selector: string): T {
  const element = hud.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Unable to initialize game HUD: missing ${selector}.`);
  }
  return element;
}

const healthText = requireHudElement<HTMLElement>("[data-health]");
const aliveText = requireHudElement<HTMLElement>("[data-alive]");
const scoreText = requireHudElement<HTMLElement>("[data-score]");
const stormText = requireHudElement<HTMLElement>("[data-storm]");
const weaponNameText = requireHudElement<HTMLElement>("[data-weapon-name]");
const weaponInfoText = requireHudElement<HTMLElement>("[data-weapon-info]");
const healthBar = requireHudElement<HTMLElement>("[data-health-bar]");
const cooldownBar = requireHudElement<HTMLElement>("[data-cooldown]");
const chargeBar = requireHudElement<HTMLElement>("[data-charge]");
const message = requireHudElement<HTMLElement>("[data-message]");
const startPanel = requireHudElement<HTMLElement>("[data-start-panel]");
const endPanel = requireHudElement<HTMLElement>("[data-end-panel]");
const endTitle = requireHudElement<HTMLElement>("[data-end-title]");
const endCopy = requireHudElement<HTMLElement>("[data-end-copy]");
const startButton = requireHudElement<HTMLButtonElement>("[data-start-button]");
const restartButton = requireHudElement<HTMLButtonElement>("[data-restart-button]");

const clock = new THREE.Clock();
const world = new THREE.Group();
const props = new THREE.Group();
const enemiesGroup = new THREE.Group();
const pickupsGroup = new THREE.Group();
const slashEffects = new THREE.Group();
scene.add(world, props, enemiesGroup, pickupsGroup, slashEffects);

const sharedGeometries = {
  stormRing: new THREE.RingGeometry(1, 1.8, 40),
  safeRing: new THREE.RingGeometry(1, 1.08, 40),
  weaponHandle: new THREE.CylinderGeometry(0.055, 0.075, 1, 8),
  weaponBlade: new THREE.BoxGeometry(1, 0.1, 0.16),
  weaponTip: new THREE.ConeGeometry(0.14, 0.28, 4),
  rock: new THREE.DodecahedronGeometry(1, 0),
  treeTrunk: new THREE.CylinderGeometry(0.22, 0.34, 2.1, 6),
  pickupPlatform: new THREE.CylinderGeometry(0.78, 0.92, 0.18, 10),
  slashRing: new THREE.RingGeometry(0.42, 1, 16, 1, -0.55, 1.1),
};

const stoneMaterial = new THREE.MeshStandardMaterial({
  color: 0x6a737f,
  roughness: 0.88,
  metalness: 0.04,
});
const woodMaterial = new THREE.MeshStandardMaterial({
  color: 0x6b4428,
  roughness: 0.9,
  metalness: 0.02,
});
const playerPalette: HumanoidPalette = {
  skin: new THREE.MeshStandardMaterial({ color: 0xd4a882, roughness: 0.76, metalness: 0.02 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0x3d4f5c, roughness: 0.82, metalness: 0.12 }),
  pants: new THREE.MeshStandardMaterial({ color: 0x2a3238, roughness: 0.9, metalness: 0.04 }),
  boots: new THREE.MeshStandardMaterial({ color: 0x1e1814, roughness: 0.88, metalness: 0.08 }),
};
const enemyPalette: HumanoidPalette = {
  skin: new THREE.MeshStandardMaterial({ color: 0xc9a07e, roughness: 0.78, metalness: 0.02 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0x5a3038, roughness: 0.84, metalness: 0.1 }),
  pants: new THREE.MeshStandardMaterial({ color: 0x2f2426, roughness: 0.9, metalness: 0.05 }),
  boots: new THREE.MeshStandardMaterial({ color: 0x141010, roughness: 0.9, metalness: 0.06 }),
};
const gripMaterial = new THREE.MeshStandardMaterial({
  color: 0x1e1814,
  roughness: 0.88,
  metalness: 0.05,
});
const stormMaterial = new THREE.MeshBasicMaterial({
  color: 0x5a4a8a,
  transparent: true,
  opacity: 0.14,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const safeZoneMaterial = new THREE.MeshBasicMaterial({
  color: 0x6a9ab8,
  transparent: true,
  opacity: 0.22,
  side: THREE.DoubleSide,
  depthWrite: false,
});

const weaponBladeMaterials = weapons.map(
  (weapon) =>
    new THREE.MeshStandardMaterial({
      color: weapon.color,
      roughness: 0.35,
      metalness: 0.82,
    }),
);

const ambientLight = new THREE.HemisphereLight(0xc8dff5, 0x3a4a32, 0.72);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
sun.position.set(42, 58, 24);
scene.add(sun);

const arenaTerrain = createArenaTerrain();
world.add(arenaTerrain.mesh);

const moveMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.52, 12),
  new THREE.MeshBasicMaterial({
    color: 0x7ec8ff,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  }),
);
moveMarker.rotation.x = -Math.PI / 2;
moveMarker.visible = false;
scene.add(moveMarker);

const stormRing = new THREE.Mesh(sharedGeometries.stormRing, stormMaterial);
stormRing.rotation.x = -Math.PI / 2;
stormRing.position.y = 0.09;
scene.add(stormRing);

const safeRing = new THREE.Mesh(sharedGeometries.safeRing, safeZoneMaterial);
safeRing.rotation.x = -Math.PI / 2;
safeRing.position.y = 0.12;
scene.add(safeRing);

const player = new THREE.Group();
scene.add(player);

const playerHumanoid = createHumanoid(playerPalette, 1, false);
player.add(playerHumanoid.root);

const playerWeapon = new THREE.Group();
playerHumanoid.weaponMount.add(playerWeapon);

const raycaster = new THREE.Raycaster();
const mouseNdc = new THREE.Vector2();
const moveTarget = new THREE.Vector3();
const tempVector = new THREE.Vector3();
const tempVectorTwo = new THREE.Vector3();
const cameraTarget = new THREE.Vector3();
const playerDirection = new THREE.Vector3(0, 0, 1);
const playerVelocity = new THREE.Vector3();
const cameraShake = new THREE.Vector3();
const dummy = new THREE.Object3D();

let state: GameState = "start";
let playerHealth = 100;
let score = 0;
let equippedWeapon = weapons[0];
let equippedWeaponIndex = 0;
let attackCooldown = 0;
let attackTime = 0;
let attackAnimDuration = 0.26;
let dashCooldown = 0;
let invulnerable = 0;
let stormRadius = 78;
let stormTimer = 0;
let cameraYaw = Math.PI;
let cameraPitch = 0.48;
let nearestPickup: Pickup | null = null;
let cameraShakeDecay = 0;
let headBobPhase = 0;
let hasMoveTarget = false;
let isCameraRotating = false;
let cameraRotateStartX = 0;
let cameraRotateStartY = 0;
let isAttackKeyHeld = false;
let attackChargeTime = 0;

const enemies: Enemy[] = [];
const pickups: Pickup[] = [];

const hudCache = {
  health: -1,
  alive: -1,
  score: -1,
  storm: -1,
  healthScale: -1,
  cooldownScale: -1,
  chargeScale: -1,
};

const SLASH_POOL_SIZE = 2;
const ENEMY_UPDATE_NEAR = 42;
let tickFrame = 0;
const slashPool: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];

for (let index = 0; index < SLASH_POOL_SIZE; index += 1) {
  const slashMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const slash = new THREE.Mesh(sharedGeometries.slashRing, slashMaterial);
  slash.visible = false;
  slash.rotation.x = -Math.PI / 2;
  slash.userData.life = 0;
  slashEffects.add(slash);
  slashPool.push(slash);
}

function getWeaponIndex(weapon: Weapon): number {
  return weapons.indexOf(weapon);
}

function snapToGround(object: THREE.Object3D): void {
  object.position.y = sampleTerrainHeight(object.position.x, object.position.z);
}

function getGroundPointFromEvent(event: MouseEvent): THREE.Vector3 | null {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNdc, camera);
  const hit = raycaster.intersectObject(arenaTerrain.mesh, false)[0];
  return hit ? hit.point : null;
}

function setMoveDestination(point: THREE.Vector3): void {
  moveTarget.set(point.x, sampleTerrainHeight(point.x, point.z), point.z);
  hasMoveTarget = true;
  moveMarker.visible = true;
  moveMarker.position.set(moveTarget.x, moveTarget.y + 0.12, moveTarget.z);
}

function clearMoveDestination(): void {
  hasMoveTarget = false;
  moveMarker.visible = false;
}

function faceTowardGroundPoint(point: THREE.Vector3): void {
  tempVectorTwo.set(point.x - player.position.x, 0, point.z - player.position.z);
  if (tempVectorTwo.lengthSq() > 0.0004) {
    playerDirection.copy(tempVectorTwo.normalize());
    player.rotation.y = Math.atan2(playerDirection.x, playerDirection.z);
  }
}

function setPlayerFacingFromCamera(): void {
  playerDirection.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
  player.rotation.y = Math.atan2(playerDirection.x, playerDirection.z);
}

function beginAttackCharge(): void {
  if (state !== "playing" || isAttackKeyHeld) {
    return;
  }
  isAttackKeyHeld = true;
  attackChargeTime = 0;
  setPlayerFacingFromCamera();
}

function releaseAttackCharge(): void {
  if (!isAttackKeyHeld) {
    return;
  }
  const charged = attackChargeTime >= ATTACK_CHARGE_TIME;
  isAttackKeyHeld = false;
  attackChargeTime = 0;
  playAttackVisuals(charged);
  applyAttackDamage(charged);
}

function createWeaponMesh(weapon: Weapon): THREE.Group {
  const weaponIndex = getWeaponIndex(weapon);
  const bladeMaterial = weaponBladeMaterials[weaponIndex] ?? weaponBladeMaterials[0];
  const weaponGroup = new THREE.Group();

  const handle = new THREE.Mesh(sharedGeometries.weaponHandle, gripMaterial);
  handle.scale.set(1, weapon.handleLength, 1);
  handle.rotation.z = Math.PI / 2;
  handle.castShadow = false;
  weaponGroup.add(handle);

  const blade = new THREE.Mesh(sharedGeometries.weaponBlade, bladeMaterial);
  blade.scale.set(weapon.bladeLength, 1, 1);
  blade.position.x = weapon.bladeLength / 2 + weapon.handleLength / 2;
  blade.castShadow = false;
  weaponGroup.add(blade);

  const tip = new THREE.Mesh(sharedGeometries.weaponTip, bladeMaterial);
  tip.position.x = weapon.bladeLength + weapon.handleLength / 2 + 0.14;
  tip.rotation.z = -Math.PI / 2;
  tip.castShadow = false;
  weaponGroup.add(tip);

  if (weapon.name.includes("Axe")) {
    const axeHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.65, 0.14),
      bladeMaterial,
    );
    axeHead.position.x = weapon.bladeLength + weapon.handleLength / 2 - 0.05;
    axeHead.position.y = 0.2;
    axeHead.castShadow = false;
    weaponGroup.add(axeHead);
  }

  return weaponGroup;
}

function equipWeapon(weapon: Weapon): void {
  equippedWeapon = weapon;
  equippedWeaponIndex = getWeaponIndex(weapon);
  playerWeapon.clear();
  const mesh = createWeaponMesh(weapon);
  mesh.rotation.z = -0.15;
  playerWeapon.add(mesh);
  weaponNameText.textContent = weapon.name;
  weaponInfoText.textContent = `${weapon.damage} damage | ${weapon.range.toFixed(
    1,
  )}m range | ${(weapon.cooldown * 1000).toFixed(0)}ms recovery`;
}

function createEnemy(x: number, z: number, scale = 1): Enemy {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  snapToGround(group);

  const humanoid = createHumanoid(enemyPalette, scale, false);
  group.add(humanoid.root);

  const bladeMaterial = weaponBladeMaterials[Math.floor(Math.random() * weapons.length)];
  const blade = new THREE.Mesh(sharedGeometries.weaponBlade, bladeMaterial);
  blade.scale.set(0.75 * scale, 1, 1);
  blade.rotation.z = 0.2;
  blade.castShadow = false;
  humanoid.weaponMount.add(blade);

  enemiesGroup.add(group);

  return {
    group,
    humanoid,
    walkPhase: Math.random() * Math.PI * 2,
    health: 80 + scale * 20,
    maxHealth: 80 + scale * 20,
    speed: 2.35 + Math.random() * 0.95,
    radius: 0.52 * scale,
    cooldown: Math.random() * 1.4,
    stun: 0,
  };
}

function createPickup(weapon: Weapon, x: number, z: number): Pickup {
  const group = new THREE.Group();
  const groundY = sampleTerrainHeight(x, z);
  group.position.set(x, groundY + 0.55, z);
  const weaponIndex = getWeaponIndex(weapon);

  const platform = new THREE.Mesh(
    sharedGeometries.pickupPlatform,
    weaponBladeMaterials[weaponIndex] ?? weaponBladeMaterials[0],
  );
  platform.castShadow = false;
  group.add(platform);

  const weaponMesh = createWeaponMesh(weapon);
  weaponMesh.position.y = 0.42;
  weaponMesh.rotation.z = 0.65;
  weaponMesh.scale.setScalar(0.9);
  group.add(weaponMesh);

  const pickup = {
    group,
    weapon,
    bobOffset: Math.random() * Math.PI * 2,
  };
  pickupsGroup.add(group);
  pickups.push(pickup);
  return pickup;
}

function addProps(): void {
  const rockCount = 8;
  const rocks = new THREE.InstancedMesh(sharedGeometries.rock, stoneMaterial, rockCount);
  rocks.castShadow = false;
  rocks.receiveShadow = true;

  for (let index = 0; index < rockCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 28 + Math.random() * 54;
    const size = 0.55 + Math.random() * 1.2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const y = sampleTerrainHeight(x, z) + 0.25 * size;
    dummy.position.set(x, y, z);
    dummy.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    dummy.scale.set(size, size * (0.5 + Math.random() * 0.35), size);
    dummy.updateMatrix();
    rocks.setMatrixAt(index, dummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  props.add(rocks);

  const treeCount = 10;
  const trunks = new THREE.InstancedMesh(sharedGeometries.treeTrunk, woodMaterial, treeCount);
  trunks.castShadow = false;

  for (let index = 0; index < treeCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 24 + Math.random() * 62;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const scale = 0.9 + Math.random() * 0.3;
    const groundY = sampleTerrainHeight(x, z);

    dummy.position.set(x, groundY + 1.15 * scale, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.set(scale, scale * 1.35, scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);
  }
  trunks.instanceMatrix.needsUpdate = true;
  props.add(trunks);

}

function spawnMatch(): void {
  enemiesGroup.clear();
  pickupsGroup.clear();
  enemies.length = 0;
  pickups.length = 0;
  slashPool.forEach((slash) => {
    slash.visible = false;
    slash.userData.life = 0;
  });

  player.position.set(0, 0, 0);
  playerVelocity.set(0, 0, 0);
  playerDirection.set(0, 0, 1);
  player.rotation.y = 0;
  playerHealth = 100;
  score = 0;
  attackCooldown = 0;
  attackTime = 0;
  dashCooldown = 0;
  invulnerable = 0;
  stormRadius = 78;
  stormTimer = 0;
  nearestPickup = null;
  cameraShakeDecay = 0;
  clearMoveDestination();
  isAttackKeyHeld = false;
  attackChargeTime = 0;
  hudCache.health = -1;
  hudCache.chargeScale = -1;
  equipWeapon(weapons[0]);

  snapToGround(player);

  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2 + Math.random() * 0.35;
    const radius = 19 + Math.random() * 36;
    enemies.push(
      createEnemy(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.94 + Math.random() * 0.18),
    );
  }

  for (let index = 0; index < 6; index += 1) {
    const weapon = weapons[1 + Math.floor(Math.random() * (weapons.length - 1))];
    const angle = Math.random() * Math.PI * 2;
    const radius = 8 + Math.random() * 58;
    createPickup(weapon, Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
}

function setState(nextState: GameState): void {
  state = nextState;
  startPanel.classList.toggle("hidden", nextState !== "start");
  endPanel.classList.toggle("hidden", nextState !== "ended");
  message.classList.toggle("hidden", nextState !== "playing");
}

function startMatch(): void {
  spawnMatch();
  setState("playing");
  message.textContent = "Right-click to move · Hold A in front of you to charge";
  message.classList.remove("hidden");
}

function endMatch(won: boolean): void {
  setState("ended");
  clearMoveDestination();
  endTitle.textContent = won ? "Victory Royale" : "Eliminated";
  endCopy.textContent = won
    ? `You cleared the arena with ${score} eliminations.`
    : `You scored ${score} eliminations before the storm or an enemy got you.`;
}

function applyPlayerDamage(amount: number): void {
  if (invulnerable > 0 || state !== "playing") {
    return;
  }
  playerHealth = Math.max(0, playerHealth - amount);
  invulnerable = 0.45;
  cameraShakeDecay = 0.35;
  if (playerHealth <= 0) {
    endMatch(false);
  }
}

function removeEnemy(enemy: Enemy): void {
  const index = enemies.indexOf(enemy);
  if (index >= 0) {
    enemies.splice(index, 1);
  }
  enemiesGroup.remove(enemy.group);
  score += 1;

  if (Math.random() > 0.48) {
    const weapon = weapons[1 + Math.floor(Math.random() * (weapons.length - 1))];
    createPickup(weapon, enemy.group.position.x, enemy.group.position.z);
  }

  if (enemies.length === 0) {
    endMatch(true);
  }
}

function spawnSlashEffect(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  range: number,
  charged: boolean,
): void {
  const slash = slashPool.find((candidate) => !candidate.visible);
  if (!slash) {
    return;
  }

  const bladeColor = new THREE.Color(weapons[equippedWeaponIndex]?.color ?? 0xffffff);
  if (charged) {
    bladeColor.lerp(new THREE.Color(0xfff2c2), 0.45);
  }
  slash.material.color.copy(bladeColor);
  slash.material.opacity = charged ? 0.78 : 0.58;
  const scale = range * (charged ? 1.28 : 1);
  slash.scale.set(scale, scale, 1);
  slash.position.copy(origin).addScaledVector(direction, range * 0.45);
  slash.position.y = sampleTerrainHeight(slash.position.x, slash.position.z) + 0.08;
  slash.rotation.z = Math.atan2(direction.z, direction.x) - 0.55;
  slash.userData.maxLife = charged ? 0.24 : 0.16;
  slash.userData.life = slash.userData.maxLife;
  slash.visible = true;
}

function playAttackVisuals(charged: boolean): void {
  if (state !== "playing") {
    return;
  }

  setPlayerFacingFromCamera();
  const range = equippedWeapon.range * (charged ? CHARGED_RANGE_MULTIPLIER : 1);
  attackAnimDuration = charged ? 0.38 : 0.26;
  attackTime = attackAnimDuration;
  spawnSlashEffect(player.position, playerDirection, range, charged);
  cameraShakeDecay = Math.max(cameraShakeDecay, charged ? 0.28 : 0.12);
}

function applyAttackDamage(charged: boolean): boolean {
  if (state !== "playing" || attackCooldown > 0) {
    return false;
  }

  const range = equippedWeapon.range * (charged ? CHARGED_RANGE_MULTIPLIER : 1);
  const damage = equippedWeapon.damage * (charged ? CHARGED_DAMAGE_MULTIPLIER : 1);
  const knockback = equippedWeapon.knockback * (charged ? CHARGED_KNOCKBACK_MULTIPLIER : 1);
  const arc = equippedWeapon.arc * (charged ? 1.12 : 1);

  attackCooldown = equippedWeapon.cooldown * (charged ? 1.35 : 1);

  for (const enemy of enemies) {
    const offset = tempVector.copy(enemy.group.position).sub(player.position);
    offset.y = 0;
    const distance = offset.length();
    if (distance > range + enemy.radius) {
      continue;
    }

    const angle = playerDirection.angleTo(offset.normalize());
    if (angle > arc / 2) {
      continue;
    }

    enemy.health -= damage;
    enemy.stun = charged ? 0.38 : 0.22;
    enemy.group.position.addScaledVector(playerDirection, knockback * 0.07);

    if (enemy.health <= 0) {
      removeEnemy(enemy);
    }
  }

  return true;
}

function pickUpNearest(): void {
  if (!nearestPickup) {
    return;
  }
  equipWeapon(nearestPickup.weapon);
  pickupsGroup.remove(nearestPickup.group);
  const index = pickups.indexOf(nearestPickup);
  if (index >= 0) {
    pickups.splice(index, 1);
  }
  nearestPickup = null;
}

function updateMovement(delta: number): void {
  let moveSpeed = 0;

  if (hasMoveTarget) {
    tempVectorTwo.set(
      moveTarget.x - player.position.x,
      0,
      moveTarget.z - player.position.z,
    );
    const distance = tempVectorTwo.length();

    if (distance < 0.42) {
      clearMoveDestination();
      playerVelocity.set(0, 0, 0);
    } else {
      tempVectorTwo.normalize();
      playerDirection.copy(tempVectorTwo);
      moveSpeed = 5.2;
      const step = Math.min(distance, moveSpeed * delta);
      player.position.x += tempVectorTwo.x * step;
      player.position.z += tempVectorTwo.z * step;
      headBobPhase += delta * 10;
    }
  } else {
    playerVelocity.set(0, 0, 0);
    headBobPhase *= 0.92;
  }

  const distanceFromCenter = Math.hypot(player.position.x, player.position.z);
  if (distanceFromCenter > ARENA_RADIUS - 2) {
    player.position.multiplyScalar((ARENA_RADIUS - 2) / distanceFromCenter);
    if (hasMoveTarget) {
      moveTarget.copy(player.position);
      moveMarker.position.set(moveTarget.x, moveTarget.y + 0.12, moveTarget.z);
    }
  }

  player.rotation.y = Math.atan2(playerDirection.x, playerDirection.z);
  snapToGround(player);
  const swingPhase =
    attackTime > 0 ? 1 - attackTime / Math.max(attackAnimDuration, 0.001) : 0;
  const chargeRatio = THREE.MathUtils.clamp(attackChargeTime / ATTACK_CHARGE_TIME, 0, 1);
  const chargedWindup =
    isAttackKeyHeld && attackChargeTime >= ATTACK_CHARGE_TIME;

  if (attackTime > 0 || isAttackKeyHeld) {
    if (isAttackKeyHeld) {
      setPlayerFacingFromCamera();
    }
    applyAttackPose(
      playerHumanoid,
      swingPhase,
      isAttackKeyHeld ? chargeRatio : 0,
      chargedWindup || (attackTime > 0 && attackAnimDuration > 0.3),
    );
  } else {
    animateHumanoid(playerHumanoid, moveSpeed, headBobPhase, 0);
  }

  if (dashCooldown > 0) {
    dashCooldown -= delta;
  }
}

function dash(): void {
  if (state !== "playing" || dashCooldown > 0) {
    return;
  }

  if (hasMoveTarget) {
    faceTowardGroundPoint(moveTarget);
  }

  player.position.addScaledVector(playerDirection, 4.2);
  if (hasMoveTarget) {
    moveTarget.copy(player.position);
    moveMarker.position.set(moveTarget.x, moveTarget.y + 0.12, moveTarget.z);
  }
  dashCooldown = 1.35;
  invulnerable = Math.max(invulnerable, 0.22);
  cameraShakeDecay = 0.28;
  snapToGround(player);
}

function updateCamera(delta: number): void {
  cameraPitch = THREE.MathUtils.clamp(cameraPitch, 0.28, 0.82);
  const radius = 7.6;
  const height = 2.8 + cameraPitch * 4.2;
  cameraTarget.copy(player.position).add(new THREE.Vector3(0, 1.62, 0));

  if (cameraShakeDecay > 0) {
    cameraShakeDecay = Math.max(0, cameraShakeDecay - delta * 2.8);
    cameraShake.set(
      (Math.random() - 0.5) * cameraShakeDecay * 0.35,
      (Math.random() - 0.5) * cameraShakeDecay * 0.2,
      (Math.random() - 0.5) * cameraShakeDecay * 0.35,
    );
  } else {
    cameraShake.set(0, 0, 0);
  }

  const desired = tempVector.set(
    player.position.x - Math.sin(cameraYaw) * radius,
    player.position.y + height,
    player.position.z - Math.cos(cameraYaw) * radius,
  );
  desired.add(cameraShake);
  camera.position.lerp(desired, 1 - Math.exp(-10 * delta));
  camera.lookAt(cameraTarget);
}

function updateEnemies(delta: number): void {
  const skipFarAi = tickFrame % 2 === 1;

  for (const enemy of enemies) {
    enemy.cooldown = Math.max(0, enemy.cooldown - delta);
    enemy.stun = Math.max(0, enemy.stun - delta);

    const distToPlayer = enemy.group.position.distanceTo(player.position);
    if (skipFarAi && distToPlayer > ENEMY_UPDATE_NEAR) {
      continue;
    }

    const toPlayer = tempVector.copy(player.position).sub(enemy.group.position);
    toPlayer.y = 0;
    const distance = toPlayer.length();
    const direction = distance > 0.001 ? toPlayer.normalize() : tempVector.set(0, 0, 1);
    enemy.group.rotation.y = Math.atan2(direction.x, direction.z);

    let moveSpeed = 0;
    if (enemy.stun <= 0) {
      if (distance > 1.55) {
        enemy.group.position.addScaledVector(direction, enemy.speed * delta);
        moveSpeed = enemy.speed;
      } else if (enemy.cooldown <= 0) {
        applyPlayerDamage(11);
        enemy.cooldown = 0.9 + Math.random() * 0.4;
      }
    }

    const distFromCenter = Math.hypot(enemy.group.position.x, enemy.group.position.z);
    if (distFromCenter > stormRadius - 2) {
      tempVectorTwo.copy(enemy.group.position).multiplyScalar(-1).normalize();
      enemy.group.position.addScaledVector(tempVectorTwo, enemy.speed * delta * 1.2);
      moveSpeed = enemy.speed;
    }

    snapToGround(enemy.group);
    if (distToPlayer < 36 && moveSpeed > 0.05) {
      enemy.walkPhase += delta * (4.5 + moveSpeed * 0.55);
      animateHumanoid(enemy.humanoid, moveSpeed, enemy.walkPhase, 0);
    }
  }
}

function updatePickups(delta: number): void {
  let nearestDistance = Number.POSITIVE_INFINITY;
  nearestPickup = null;

  for (const pickup of pickups) {
    const distance = pickup.group.position.distanceTo(player.position);
    if (distance < 55) {
      pickup.group.rotation.y += delta * 1.1;
      const groundY = sampleTerrainHeight(pickup.group.position.x, pickup.group.position.z);
      pickup.group.position.y =
        groundY + 0.55 + Math.sin(clock.elapsedTime * 2.1 + pickup.bobOffset) * 0.1;
    }
    if (distance < 2.4 && distance < nearestDistance) {
      nearestDistance = distance;
      nearestPickup = pickup;
    }
  }

  if (nearestPickup) {
    message.textContent = `Press E to pick up ${nearestPickup.weapon.name}`;
    message.classList.remove("hidden");
  } else if (state === "playing") {
    if (isAttackKeyHeld && attackChargeTime >= ATTACK_CHARGE_TIME) {
      message.textContent = "Charged — release A";
    } else if (isAttackKeyHeld) {
      message.textContent = "Charging slash ahead…";
    } else {
      message.textContent = "Right-click to move · Hold A to slash in front";
    }
    message.classList.remove("hidden");
  }
}

function updateStorm(delta: number): void {
  stormTimer += delta;
  stormRadius = Math.max(22, 78 - stormTimer * 0.18);
  stormRing.scale.setScalar(stormRadius);
  safeRing.scale.setScalar(stormRadius - 1.8);

  const distance = Math.hypot(player.position.x, player.position.z);
  if (distance > stormRadius) {
    applyPlayerDamage(delta * 10);
  }
}

function updateSlashEffects(delta: number): void {
  for (const effect of slashPool) {
    if (!effect.visible) {
      continue;
    }
    const life = Number(effect.userData.life) - delta;
    effect.userData.life = life;
    effect.scale.multiplyScalar(1 + delta * 2.1);
    const maxLife = Number(effect.userData.maxLife) || 0.16;
    effect.material.opacity = Math.max(0, life / maxLife) * 0.58;
    if (life <= 0) {
      effect.visible = false;
      effect.userData.life = 0;
    }
  }
}

function updateWeapon(delta: number): void {
  attackCooldown = Math.max(0, attackCooldown - delta);
  attackTime = Math.max(0, attackTime - delta);
  invulnerable = Math.max(0, invulnerable - delta);

  if (isAttackKeyHeld) {
    attackChargeTime = Math.min(attackChargeTime + delta, ATTACK_CHARGE_TIME + 0.05);
    setPlayerFacingFromCamera();
  }

  const swingPhase =
    attackTime > 0 ? 1 - attackTime / Math.max(attackAnimDuration, 0.001) : 0;
  const chargeRatio = THREE.MathUtils.clamp(attackChargeTime / ATTACK_CHARGE_TIME, 0, 1);
  const weaponWindup = isAttackKeyHeld ? chargeRatio * 1.2 : 0;
  const weaponSwing = attackTime > 0 ? Math.sin(swingPhase * Math.PI) : 0;
  playerWeapon.rotation.set(0.15, 0.1, -0.35 - weaponSwing * 0.85 - weaponWindup);

  const flashing = invulnerable > 0 && Math.sin(clock.elapsedTime * 34) > 0;
  setHumanoidFlash(playerHumanoid, playerPalette, flashing);
}

function updateHud(): void {
  const health = Math.ceil(playerHealth);
  const alive = enemies.length + 1;
  const storm = Math.max(0, Math.round(stormRadius));
  const healthScale = THREE.MathUtils.clamp(playerHealth / 100, 0, 1);
  const cooldownScale =
    1 - THREE.MathUtils.clamp(attackCooldown / equippedWeapon.cooldown, 0, 1);

  if (health !== hudCache.health) {
    healthText.textContent = health.toString();
    hudCache.health = health;
  }
  if (alive !== hudCache.alive) {
    aliveText.textContent = alive.toString();
    hudCache.alive = alive;
  }
  if (score !== hudCache.score) {
    scoreText.textContent = score.toString();
    hudCache.score = score;
  }
  if (storm !== hudCache.storm) {
    stormText.textContent = `${storm}m`;
    hudCache.storm = storm;
  }
  if (healthScale !== hudCache.healthScale) {
    healthBar.style.transform = `scaleX(${healthScale})`;
    hudCache.healthScale = healthScale;
  }
  if (cooldownScale !== hudCache.cooldownScale) {
    cooldownBar.style.transform = `scaleX(${cooldownScale})`;
    hudCache.cooldownScale = cooldownScale;
  }

  const chargeScale = isAttackKeyHeld
    ? THREE.MathUtils.clamp(attackChargeTime / ATTACK_CHARGE_TIME, 0, 1)
    : 0;
  if (chargeScale !== hudCache.chargeScale) {
    chargeBar.style.transform = `scaleX(${chargeScale})`;
    chargeBar.classList.toggle("ready", chargeScale >= 1);
    hudCache.chargeScale = chargeScale;
  }
}

function tick(): void {
  const delta = Math.min(clock.getDelta(), 0.033);
  tickFrame += 1;

  if (state === "playing") {
    updateMovement(delta);
    updateWeapon(delta);
    updateEnemies(delta);
    if (tickFrame % 2 === 0) {
      updatePickups(delta);
    }
    updateStorm(delta);
  }

  if (tickFrame % 2 === 0) {
    updateSlashEffects(delta);
    updateCamera(delta);
    updateHud();
  } else if (state === "playing") {
    updateCamera(delta);
  }

  renderer.render(scene, camera);
}

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  if (event.repeat) {
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    dash();
  }
  if (event.code === "KeyA") {
    event.preventDefault();
    beginAttackCharge();
  }
  if (event.code === "KeyE") {
    pickUpNearest();
  }
  if (event.code === "KeyR" && state !== "playing") {
    startMatch();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "KeyA") {
    releaseAttackCharge();
  }
});

renderer.domElement.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

renderer.domElement.addEventListener("mousedown", (event) => {
  if (state !== "playing") {
    return;
  }

  if (event.button === 0) {
    isCameraRotating = true;
    cameraRotateStartX = event.clientX;
    cameraRotateStartY = event.clientY;
    return;
  }

  if (event.button === 2) {
    cameraRotateStartX = event.clientX;
    cameraRotateStartY = event.clientY;
  }
});

renderer.domElement.addEventListener("mouseup", (event) => {
  if (state !== "playing") {
    return;
  }

  if (event.button === 0) {
    isCameraRotating = false;
    return;
  }

  if (event.button !== 2) {
    return;
  }

  const dragDistance = Math.hypot(
    event.clientX - cameraRotateStartX,
    event.clientY - cameraRotateStartY,
  );

  if (dragDistance > 6) {
    return;
  }

  const groundPoint = getGroundPointFromEvent(event);
  if (groundPoint) {
    setMoveDestination(groundPoint);
  }
});

window.addEventListener("mousemove", (event) => {
  if (!isCameraRotating) {
    return;
  }
  cameraYaw -= event.movementX * 0.0022;
  cameraPitch -= event.movementY * 0.0014;
});

startButton.addEventListener("click", startMatch);
restartButton.addEventListener("click", startMatch);

addProps();
snapToGround(player);
equipWeapon(equippedWeapon);
setState("start");
updateCamera(1);
renderer.setAnimationLoop(tick);
