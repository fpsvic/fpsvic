import * as THREE from "three";
import {
  animateHumanoid,
  createHumanoid,
  setHumanoidFlash,
  type HumanoidPalette,
  type HumanoidRig,
} from "./humanoid";
import { createArenaTerrain, sampleTerrainHeight } from "./terrain";
import "./styles.css";

const ARENA_RADIUS = 90;

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
scene.fog = new THREE.Fog(horizonColor.getHex(), 48, 165);

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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
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
    <div class="health-wrap"><div class="health-bar" data-health-bar></div></div>
  </div>

  <div class="bottom-bar">
    <div class="controls">
      <div><kbd>WASD</kbd> move</div>
      <div><kbd>Mouse</kbd> aim</div>
      <div><kbd>Click</kbd> slash</div>
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
  treeLeaves: new THREE.ConeGeometry(1.1, 2.1, 6),
  pickupPlatform: new THREE.CylinderGeometry(0.78, 0.92, 0.18, 10),
  slashRing: new THREE.RingGeometry(0.42, 1, 20, 1, -0.55, 1.1),
  wall: new THREE.BoxGeometry(8, 2.8, 0.7),
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
const leavesMaterial = new THREE.MeshStandardMaterial({
  color: 0x2d6b45,
  roughness: 0.82,
  metalness: 0,
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

function addSky(): void {
  const skyUniforms = {
    topColor: { value: new THREE.Color(0x3d6ea8) },
    horizonColor: { value: horizonColor.clone() },
    bottomColor: { value: new THREE.Color(0x6a8f6a) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(280, 24, 12),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          vec3 color = h > 0.0
            ? mix(horizonColor, topColor, pow(h, 0.65))
            : mix(horizonColor, bottomColor, pow(-h, 0.85));
          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  scene.add(sky);
}

addSky();

const ambientLight = new THREE.HemisphereLight(0xc8dff5, 0x3a4a32, 0.55);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.set(42, 58, 24);
sun.castShadow = true;
sun.shadow.mapSize.set(768, 768);
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
sun.shadow.camera.left = -72;
sun.shadow.camera.right = 72;
sun.shadow.camera.top = 72;
sun.shadow.camera.bottom = -72;
sun.shadow.camera.near = 8;
sun.shadow.camera.far = 140;
scene.add(sun);

const arenaTerrain = createArenaTerrain();
world.add(arenaTerrain.mesh);

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

const playerHumanoid = createHumanoid(playerPalette, 1, true);
player.add(playerHumanoid.root);

const playerWeapon = new THREE.Group();
playerHumanoid.weaponMount.add(playerWeapon);

const keys = new Set<string>();
const moveVector = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
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
let dashCooldown = 0;
let invulnerable = 0;
let stormRadius = 78;
let stormTimer = 0;
let cameraYaw = Math.PI;
let cameraPitch = 0.48;
let nearestPickup: Pickup | null = null;
let cameraShakeDecay = 0;
let headBobPhase = 0;

const enemies: Enemy[] = [];
const pickups: Pickup[] = [];

const hudCache = {
  health: -1,
  alive: -1,
  score: -1,
  storm: -1,
  healthScale: -1,
  cooldownScale: -1,
};

const SLASH_POOL_SIZE = 5;
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
  const rockCount = 20;
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

  const treeCount = 22;
  const trunks = new THREE.InstancedMesh(sharedGeometries.treeTrunk, woodMaterial, treeCount);
  const leaves = new THREE.InstancedMesh(sharedGeometries.treeLeaves, leavesMaterial, treeCount);
  trunks.castShadow = false;
  leaves.castShadow = false;

  for (let index = 0; index < treeCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 24 + Math.random() * 62;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const scale = 0.85 + Math.random() * 0.35;
    const groundY = sampleTerrainHeight(x, z);

    dummy.position.set(x, groundY + 1.05 * scale, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);

    dummy.position.set(x, groundY + 2.75 * scale, z);
    dummy.updateMatrix();
    leaves.setMatrixAt(index, dummy.matrix);
  }
  trunks.instanceMatrix.needsUpdate = true;
  leaves.instanceMatrix.needsUpdate = true;
  props.add(trunks, leaves);

  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    const x = Math.cos(angle) * 18;
    const z = Math.sin(angle) * 18;
    const wall = new THREE.Mesh(sharedGeometries.wall, stoneMaterial);
    const groundY = sampleTerrainHeight(x, z);
    wall.position.set(x, groundY + 1.4, z);
    wall.rotation.y = -angle;
    wall.castShadow = false;
    wall.receiveShadow = true;
    props.add(wall);
  }
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
  hudCache.health = -1;
  equipWeapon(weapons[0]);

  snapToGround(player);

  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 + Math.random() * 0.35;
    const radius = 19 + Math.random() * 36;
    enemies.push(
      createEnemy(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.94 + Math.random() * 0.18),
    );
  }

  for (let index = 0; index < 10; index += 1) {
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
  renderer.domElement.requestPointerLock().catch(() => {
    message.textContent = "Click the arena to lock aim";
  });
}

function endMatch(won: boolean): void {
  setState("ended");
  endTitle.textContent = won ? "Victory Royale" : "Eliminated";
  endCopy.textContent = won
    ? `You cleared the arena with ${score} eliminations.`
    : `You scored ${score} eliminations before the storm or an enemy got you.`;
  document.exitPointerLock();
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

function spawnSlashEffect(origin: THREE.Vector3, direction: THREE.Vector3, range: number): void {
  const slash = slashPool.find((candidate) => !candidate.visible);
  if (!slash) {
    return;
  }

  const bladeColor = new THREE.Color(weapons[equippedWeaponIndex]?.color ?? 0xffffff);
  slash.material.color.copy(bladeColor);
  slash.material.opacity = 0.58;
  slash.scale.set(range, range, 1);
  slash.position.copy(origin).addScaledVector(direction, range * 0.45);
  slash.position.y = sampleTerrainHeight(slash.position.x, slash.position.z) + 0.08;
  slash.rotation.z = Math.atan2(direction.z, direction.x) - 0.55;
  slash.userData.life = 0.16;
  slash.visible = true;
}

function attack(): void {
  if (state !== "playing" || attackCooldown > 0) {
    return;
  }

  attackCooldown = equippedWeapon.cooldown;
  attackTime = 0.22;
  spawnSlashEffect(player.position, playerDirection, equippedWeapon.range);
  cameraShakeDecay = Math.max(cameraShakeDecay, 0.12);

  for (const enemy of enemies) {
    const offset = tempVector.copy(enemy.group.position).sub(player.position);
    offset.y = 0;
    const distance = offset.length();
    if (distance > equippedWeapon.range + enemy.radius) {
      continue;
    }

    const angle = playerDirection.angleTo(offset.normalize());
    if (angle > equippedWeapon.arc / 2) {
      continue;
    }

    enemy.health -= equippedWeapon.damage;
    enemy.stun = 0.22;
    enemy.group.position.addScaledVector(playerDirection, equippedWeapon.knockback * 0.07);

    if (enemy.health <= 0) {
      removeEnemy(enemy);
    }
  }
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

function updateInput(delta: number): void {
  moveVector.set(0, 0, 0);
  forward.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
  right.set(forward.z, 0, -forward.x);

  if (keys.has("KeyW")) {
    moveVector.add(forward);
  }
  if (keys.has("KeyS")) {
    moveVector.sub(forward);
  }
  if (keys.has("KeyD")) {
    moveVector.add(right);
  }
  if (keys.has("KeyA")) {
    moveVector.sub(right);
  }

  const sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight");
  const maxSpeed = sprinting ? 6.4 : 4.85;
  const accel = sprinting ? 22 : 18;
  const friction = 14;

  if (moveVector.lengthSq() > 0) {
    moveVector.normalize();
    const targetVelocity = tempVectorTwo.copy(moveVector).multiplyScalar(maxSpeed);
    playerVelocity.lerp(targetVelocity, 1 - Math.exp(-accel * delta));
    playerDirection.lerp(moveVector, Math.min(1, delta * 12)).normalize();
    headBobPhase += delta * (sprinting ? 13 : 10);
  } else {
    playerVelocity.multiplyScalar(Math.max(0, 1 - friction * delta));
    headBobPhase *= 0.92;
  }

  player.position.addScaledVector(playerVelocity, delta);

  const distanceFromCenter = Math.hypot(player.position.x, player.position.z);
  if (distanceFromCenter > ARENA_RADIUS - 2) {
    player.position.multiplyScalar((ARENA_RADIUS - 2) / distanceFromCenter);
    playerVelocity.multiplyScalar(0.35);
  }

  player.rotation.y = Math.atan2(playerDirection.x, playerDirection.z);
  snapToGround(player);
  const swing = attackTime > 0 ? Math.sin((attackTime / 0.22) * Math.PI) : 0;
  animateHumanoid(playerHumanoid, playerVelocity.length(), headBobPhase, swing);

  if (dashCooldown > 0) {
    dashCooldown -= delta;
  }
}

function dash(): void {
  if (state !== "playing" || dashCooldown > 0) {
    return;
  }
  playerVelocity.copy(playerDirection).multiplyScalar(11);
  player.position.addScaledVector(playerDirection, 3.2);
  dashCooldown = 1.35;
  invulnerable = Math.max(invulnerable, 0.22);
  cameraShakeDecay = 0.28;
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
  for (const enemy of enemies) {
    enemy.cooldown = Math.max(0, enemy.cooldown - delta);
    enemy.stun = Math.max(0, enemy.stun - delta);

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
    enemy.walkPhase += delta * (4.5 + moveSpeed * 0.55);
    animateHumanoid(enemy.humanoid, moveSpeed, enemy.walkPhase, 0);
  }
}

function updatePickups(delta: number): void {
  let nearestDistance = Number.POSITIVE_INFINITY;
  nearestPickup = null;

  for (const pickup of pickups) {
    pickup.group.rotation.y += delta * 1.2;
    const groundY = sampleTerrainHeight(pickup.group.position.x, pickup.group.position.z);
    pickup.group.position.y =
      groundY + 0.55 + Math.sin(clock.elapsedTime * 2.1 + pickup.bobOffset) * 0.1;
    const distance = pickup.group.position.distanceTo(player.position);
    if (distance < 2.4 && distance < nearestDistance) {
      nearestDistance = distance;
      nearestPickup = pickup;
    }
  }

  if (nearestPickup) {
    message.textContent = `Press E to pick up ${nearestPickup.weapon.name}`;
    message.classList.remove("hidden");
  } else if (state === "playing") {
    message.textContent = "Outlast the arena";
    message.classList.toggle("hidden", document.pointerLockElement === renderer.domElement);
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
    effect.material.opacity = Math.max(0, life / 0.16) * 0.58;
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

  const swing = attackTime > 0 ? Math.sin((attackTime / 0.22) * Math.PI) : 0;
  playerWeapon.rotation.set(0.15, 0, -0.35 - swing * 0.5);

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
}

function tick(): void {
  const delta = Math.min(clock.getDelta(), 0.033);

  if (state === "playing") {
    updateInput(delta);
    updateEnemies(delta);
    updatePickups(delta);
    updateStorm(delta);
    updateWeapon(delta);
  }

  updateSlashEffects(delta);
  updateCamera(delta);
  updateHud();
  renderer.render(scene, camera);
}

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Space") {
    event.preventDefault();
    dash();
  }
  if (event.code === "KeyE") {
    pickUpNearest();
  }
  if (event.code === "KeyR" && state !== "playing") {
    startMatch();
  }
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});
window.addEventListener("mousemove", (event) => {
  if (document.pointerLockElement !== renderer.domElement) {
    return;
  }
  cameraYaw -= event.movementX * 0.0022;
  cameraPitch -= event.movementY * 0.0014;
});
window.addEventListener("mousedown", (event) => {
  if (event.button !== 0) {
    return;
  }
  if (state === "playing") {
    if (document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock().catch(() => undefined);
    }
    attack();
  }
});

startButton.addEventListener("click", startMatch);
restartButton.addEventListener("click", startMatch);
renderer.domElement.addEventListener("click", () => {
  if (state === "playing" && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock().catch(() => undefined);
  }
});

addProps();
snapToGround(player);
equipWeapon(equippedWeapon);
setState("start");
updateCamera(1);
renderer.setAnimationLoop(tick);
