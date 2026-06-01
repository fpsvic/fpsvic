import * as THREE from "three";
import "./styles.css";

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
    color: 0x87f7ff,
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
    color: 0xb8ff6c,
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
    color: 0xffa64d,
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
    color: 0xd49cff,
    bladeLength: 2.0,
    handleLength: 0.9,
  },
];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071321);
scene.fog = new THREE.FogExp2(0x071321, 0.021);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  500,
);
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.sortObjects = false;
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
    <p>Drop into a stylized 3D battle arena where every fight is close range. Outlast the bots, loot stronger knives, swords, axes, and spears, and stay inside the shrinking storm ring.</p>
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

const ambientLight = new THREE.HemisphereLight(0xbadfff, 0x24351f, 2.1);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.position.set(30, 42, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0002;
sun.shadow.camera.left = -85;
sun.shadow.camera.right = 85;
sun.shadow.camera.top = 85;
sun.shadow.camera.bottom = -85;
scene.add(sun);

const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x1a6442,
  roughness: 0.9,
  metalness: 0.05,
});
const sandMaterial = new THREE.MeshStandardMaterial({
  color: 0xc7aa68,
  roughness: 0.95,
});
const stoneMaterial = new THREE.MeshStandardMaterial({
  color: 0x657285,
  roughness: 0.75,
});
const woodMaterial = new THREE.MeshStandardMaterial({
  color: 0x8e5a32,
  roughness: 0.82,
});
const playerMaterial = new THREE.MeshStandardMaterial({
  color: 0x36d6ff,
  roughness: 0.45,
  metalness: 0.1,
});
const enemyMaterial = new THREE.MeshStandardMaterial({
  color: 0xff5e7d,
  roughness: 0.62,
});
const stormMaterial = new THREE.MeshBasicMaterial({
  color: 0x784cff,
  transparent: true,
  opacity: 0.18,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const safeZoneMaterial = new THREE.MeshBasicMaterial({
  color: 0x72d7ff,
  transparent: true,
  opacity: 0.36,
  side: THREE.DoubleSide,
  depthWrite: false,
});

const terrain = new THREE.Mesh(new THREE.CircleGeometry(92, 64), groundMaterial);
terrain.rotation.x = -Math.PI / 2;
terrain.receiveShadow = true;
world.add(terrain);

const centerPad = new THREE.Mesh(new THREE.CircleGeometry(22, 40), sandMaterial);
centerPad.position.y = 0.012;
centerPad.rotation.x = -Math.PI / 2;
centerPad.receiveShadow = true;
world.add(centerPad);

const stormRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.8, 48), stormMaterial);
stormRing.rotation.x = -Math.PI / 2;
stormRing.position.y = 0.09;
scene.add(stormRing);

const safeRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 48), safeZoneMaterial);
safeRing.rotation.x = -Math.PI / 2;
safeRing.position.y = 0.12;
scene.add(safeRing);

const player = new THREE.Group();
player.position.set(0, 0, 0);
scene.add(player);

const playerBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.48, 1.25, 6, 10), playerMaterial);
playerBody.position.y = 1.02;
playerBody.castShadow = true;
player.add(playerBody);

const playerHeadMaterial = new THREE.MeshStandardMaterial({
  color: 0xf2c5a0,
  roughness: 0.58,
});
const playerHead = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 10), playerHeadMaterial);
playerHead.position.y = 1.98;
playerHead.castShadow = true;
player.add(playerHead);

const playerWeapon = new THREE.Group();
playerWeapon.position.set(0.58, 1.18, -0.2);
player.add(playerWeapon);

const keys = new Set<string>();
const pointer = new THREE.Vector2();
const moveVector = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const tempVector = new THREE.Vector3();
const tempVectorTwo = new THREE.Vector3();
const cameraTarget = new THREE.Vector3();
const playerDirection = new THREE.Vector3(0, 0, 1);

let state: GameState = "start";
let playerHealth = 100;
let score = 0;
let equippedWeapon = weapons[0];
let attackCooldown = 0;
let attackTime = 0;
let dashCooldown = 0;
let invulnerable = 0;
let stormRadius = 78;
let stormTimer = 0;
let cameraYaw = Math.PI;
let cameraPitch = 0.52;
let nearestPickup: Pickup | null = null;

const enemies: Enemy[] = [];
const pickups: Pickup[] = [];

const weaponGripMaterial = new THREE.MeshStandardMaterial({
  color: 0x2f2431,
  roughness: 0.75,
});
const weaponBladeMaterials = weapons.map(
  (weapon) =>
    new THREE.MeshStandardMaterial({
      color: weapon.color,
      roughness: 0.26,
      metalness: 0.7,
      emissive: weapon.color,
      emissiveIntensity: 0.12,
    }),
);
const pickupPlatformMaterials = weapons.map(
  (weapon) =>
    new THREE.MeshStandardMaterial({
      color: weapon.color,
      roughness: 0.36,
      metalness: 0.25,
      emissive: weapon.color,
      emissiveIntensity: 0.18,
    }),
);
const enemyHelmetMaterial = new THREE.MeshStandardMaterial({
  color: 0x371a2a,
  roughness: 0.5,
});

const sharedGeometries = {
  weaponHandle: new THREE.CylinderGeometry(0.055, 0.075, 1, 8),
  weaponTip: new THREE.ConeGeometry(0.16, 0.32, 4),
  weaponAxeHead: new THREE.BoxGeometry(0.24, 0.7, 0.16),
  rock: new THREE.DodecahedronGeometry(1, 0),
  trunk: new THREE.CylinderGeometry(0.25, 0.38, 2.2, 6),
  leaves: new THREE.ConeGeometry(1.2, 2.3, 6),
  wall: new THREE.BoxGeometry(8, 2.8, 0.7),
  slashRing: new THREE.RingGeometry(0.42, 1, 24, 1, -0.55, 1.1),
  enemyBody: new THREE.CapsuleGeometry(1, 1, 6, 10),
  enemyHelmet: new THREE.SphereGeometry(1, 12, 8),
  pickupPlatform: new THREE.CylinderGeometry(0.78, 0.92, 0.18, 12),
};

const leavesMaterial = new THREE.MeshStandardMaterial({ color: 0x2fa96b, roughness: 0.74 });
const propDummy = new THREE.Object3D();

const SLASH_POOL_SIZE = 4;
const slashPool: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
for (let index = 0; index < SLASH_POOL_SIZE; index += 1) {
  const slashMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const slash = new THREE.Mesh(sharedGeometries.slashRing, slashMaterial);
  slash.rotation.x = -Math.PI / 2;
  slash.visible = false;
  slash.userData.life = 0;
  slashEffects.add(slash);
  slashPool.push(slash);
}

let tickFrame = 0;
let isPageVisible = true;
const hudCache = {
  health: -1,
  alive: -1,
  score: -1,
  storm: -1,
  healthScale: -1,
  cooldownScale: -1,
};

function getWeaponIndex(weapon: Weapon): number {
  return weapons.indexOf(weapon);
}

function createWeaponMesh(weapon: Weapon): THREE.Group {
  const weaponGroup = new THREE.Group();
  const weaponIndex = getWeaponIndex(weapon);
  const bladeMaterial = weaponBladeMaterials[weaponIndex] ?? weaponBladeMaterials[0];
  const handle = new THREE.Mesh(sharedGeometries.weaponHandle, weaponGripMaterial);
  handle.scale.set(1, weapon.handleLength, 1);
  handle.rotation.z = Math.PI / 2;
  handle.castShadow = true;
  weaponGroup.add(handle);

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(weapon.bladeLength, 0.12, 0.18),
    bladeMaterial,
  );
  blade.position.x = weapon.bladeLength / 2 + weapon.handleLength / 2;
  blade.castShadow = true;
  weaponGroup.add(blade);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 4), bladeMaterial);
  tip.position.x = weapon.bladeLength + weapon.handleLength / 2 + 0.16;
  tip.rotation.z = -Math.PI / 2;
  tip.castShadow = true;
  weaponGroup.add(tip);

  if (weapon.name.includes("Axe")) {
    const axeHead = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.7, 0.16), bladeMaterial);
    axeHead.position.x = weapon.bladeLength + weapon.handleLength / 2 - 0.05;
    axeHead.position.y = 0.22;
    axeHead.castShadow = true;
    weaponGroup.add(axeHead);
  }

  return weaponGroup;
}

function equipWeapon(weapon: Weapon): void {
  equippedWeapon = weapon;
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

  const body = new THREE.Mesh(sharedGeometries.enemyBody, enemyMaterial);
  body.scale.set(0.43 * scale, 1.05 * scale, 0.43 * scale);
  body.position.y = 0.94 * scale;
  body.castShadow = true;
  group.add(body);

  const helmet = new THREE.Mesh(sharedGeometries.enemyHelmet, enemyHelmetMaterial);
  helmet.scale.setScalar(0.34 * scale);
  helmet.position.y = 1.75 * scale;
  helmet.castShadow = true;
  group.add(helmet);

  const blade = createWeaponMesh(weapons[Math.floor(Math.random() * weapons.length)]);
  blade.scale.setScalar(0.75 * scale);
  blade.position.set(0.5 * scale, 1.05 * scale, -0.08);
  blade.rotation.z = 0.2;
  group.add(blade);

  enemiesGroup.add(group);

  return {
    group,
    health: 80 + scale * 20,
    maxHealth: 80 + scale * 20,
    speed: 2.5 + Math.random() * 1.05,
    radius: 0.58 * scale,
    cooldown: Math.random() * 1.4,
    stun: 0,
  };
}

function createPickup(weapon: Weapon, x: number, z: number): Pickup {
  const group = new THREE.Group();
  group.position.set(x, 0.75, z);

  const weaponIndex = getWeaponIndex(weapon);
  const platform = new THREE.Mesh(
    sharedGeometries.pickupPlatform,
    pickupPlatformMaterials[weaponIndex] ?? pickupPlatformMaterials[0],
  );
  platform.castShadow = true;
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
  const rockCount = 38;
  const rocks = new THREE.InstancedMesh(sharedGeometries.rock, stoneMaterial, rockCount);
  rocks.castShadow = true;
  rocks.receiveShadow = true;

  for (let index = 0; index < rockCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 28 + Math.random() * 54;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const size = 0.6 + Math.random() * 1.4;
    propDummy.position.set(x, 0.45, z);
    propDummy.rotation.set(Math.random(), Math.random(), Math.random());
    propDummy.scale.set(size, size * (0.45 + Math.random() * 0.4), size);
    propDummy.updateMatrix();
    rocks.setMatrixAt(index, propDummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  props.add(rocks);

  const treeCount = 42;
  const trunks = new THREE.InstancedMesh(sharedGeometries.trunk, woodMaterial, treeCount);
  const foliage = new THREE.InstancedMesh(sharedGeometries.leaves, leavesMaterial, treeCount);
  trunks.castShadow = true;
  foliage.castShadow = true;

  for (let index = 0; index < treeCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 24 + Math.random() * 62;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const yaw = Math.random() * Math.PI * 2;

    propDummy.position.set(x, 1.1, z);
    propDummy.rotation.set(0, yaw, 0);
    propDummy.scale.set(1, 1, 1);
    propDummy.updateMatrix();
    trunks.setMatrixAt(index, propDummy.matrix);

    propDummy.position.set(x, 2.85, z);
    propDummy.updateMatrix();
    foliage.setMatrixAt(index, propDummy.matrix);
  }
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  props.add(trunks, foliage);

  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    const wall = new THREE.Mesh(sharedGeometries.wall, stoneMaterial);
    wall.position.set(Math.cos(angle) * 18, 1.4, Math.sin(angle) * 18);
    wall.rotation.y = -angle;
    wall.castShadow = true;
    wall.receiveShadow = true;
    props.add(wall);
  }
}

function spawnMatch(): void {
  enemiesGroup.clear();
  pickupsGroup.clear();
  slashPool.forEach((slash) => {
    slash.visible = false;
    slash.userData.life = 0;
  });
  enemies.length = 0;
  pickups.length = 0;
  player.position.set(0, 0, 0);
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
  hudCache.health = -1;
  hudCache.alive = -1;
  hudCache.score = -1;
  hudCache.storm = -1;
  hudCache.healthScale = -1;
  hudCache.cooldownScale = -1;
  equipWeapon(weapons[0]);

  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2 + Math.random() * 0.35;
    const radius = 19 + Math.random() * 38;
    enemies.push(createEnemy(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.9 + Math.random() * 0.28));
  }

  for (let index = 0; index < 15; index += 1) {
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

function addSlashEffect(origin: THREE.Vector3, direction: THREE.Vector3, range: number): void {
  const slash = slashPool.find((candidate) => !candidate.visible);
  if (!slash) {
    return;
  }

  slash.material.color.set(equippedWeapon.color);
  slash.material.opacity = 0.72;
  slash.scale.set(range, range, 1);
  slash.position.copy(origin).addScaledVector(direction, range * 0.45);
  slash.position.y = 0.12;
  slash.rotation.z = Math.atan2(direction.z, direction.x) - 0.55;
  slash.userData.life = 0.18;
  slash.visible = true;
}

function attack(): void {
  if (state !== "playing" || attackCooldown > 0) {
    return;
  }

  attackCooldown = equippedWeapon.cooldown;
  attackTime = 0.24;
  addSlashEffect(player.position, playerDirection, equippedWeapon.range);

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
    enemy.stun = 0.2;
    enemy.group.position.addScaledVector(playerDirection, equippedWeapon.knockback * 0.08);

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

  if (moveVector.lengthSq() > 0) {
    moveVector.normalize();
    playerDirection.lerp(moveVector, Math.min(1, delta * 14)).normalize();
    const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 7.3 : 5.5;
    player.position.addScaledVector(moveVector, speed * delta);
  }

  const distanceFromCenter = Math.hypot(player.position.x, player.position.z);
  if (distanceFromCenter > 86) {
    player.position.multiplyScalar(86 / distanceFromCenter);
  }

  player.rotation.y = Math.atan2(playerDirection.x, playerDirection.z);
  playerBody.scale.setScalar(invulnerable > 0 && Math.sin(clock.elapsedTime * 38) > 0 ? 0.92 : 1);

  if (dashCooldown > 0) {
    dashCooldown -= delta;
  }
}

function dash(): void {
  if (state !== "playing" || dashCooldown > 0) {
    return;
  }
  player.position.addScaledVector(playerDirection, 4.8);
  dashCooldown = 1.35;
  invulnerable = Math.max(invulnerable, 0.22);
}

function updateCamera(delta: number): void {
  cameraPitch = THREE.MathUtils.clamp(cameraPitch, 0.22, 0.95);
  const radius = 8.4;
  const height = 3.2 + cameraPitch * 4.5;
  cameraTarget.copy(player.position).add(new THREE.Vector3(0, 1.45, 0));
  const desired = tempVector.set(
    player.position.x - Math.sin(cameraYaw) * radius,
    player.position.y + height,
    player.position.z - Math.cos(cameraYaw) * radius,
  );
  camera.position.lerp(desired, Math.min(1, delta * 8.5));
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

    if (enemy.stun <= 0) {
      if (distance > 1.45) {
        enemy.group.position.addScaledVector(direction, enemy.speed * delta);
      } else if (enemy.cooldown <= 0) {
        applyPlayerDamage(12);
        enemy.cooldown = 0.85 + Math.random() * 0.45;
      }
    }

    const distFromCenter = Math.hypot(enemy.group.position.x, enemy.group.position.z);
    if (distFromCenter > stormRadius - 2) {
      tempVectorTwo.copy(enemy.group.position).multiplyScalar(-1).normalize();
      enemy.group.position.addScaledVector(tempVectorTwo, enemy.speed * delta * 1.25);
    }

    enemy.group.children.forEach((child, index) => {
      const mesh = child as THREE.Object3D & { userData: { baseY?: number } };
      if (mesh.userData.baseY === undefined) {
        mesh.userData.baseY = mesh.position.y;
      }
      mesh.position.y = mesh.userData.baseY + Math.sin(clock.elapsedTime * 4 + index) * 0.0008;
    });
  }
}

function updatePickups(delta: number): void {
  let nearestDistance = Number.POSITIVE_INFINITY;
  nearestPickup = null;

  for (const pickup of pickups) {
    pickup.group.rotation.y += delta * 1.6;
    pickup.group.position.y = 0.72 + Math.sin(clock.elapsedTime * 2.4 + pickup.bobOffset) * 0.18;
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
    applyPlayerDamage(delta * 12);
  }
}

function updateSlashEffects(delta: number): void {
  for (const slash of slashPool) {
    if (!slash.visible) {
      continue;
    }
    const life = Number(slash.userData.life) - delta;
    slash.userData.life = life;
    slash.scale.multiplyScalar(1 + delta * 2.4);
    slash.material.opacity = Math.max(0, life / 0.18) * 0.72;
    if (life <= 0) {
      slash.visible = false;
      slash.userData.life = 0;
    }
  }
}

function updateWeapon(delta: number): void {
  attackCooldown = Math.max(0, attackCooldown - delta);
  attackTime = Math.max(0, attackTime - delta);
  invulnerable = Math.max(0, invulnerable - delta);

  const swing = attackTime > 0 ? Math.sin((attackTime / 0.24) * Math.PI) : 0;
  playerWeapon.rotation.set(0, 0, -0.1 - swing * 1.35);
  playerWeapon.position.set(0.58 + swing * 0.12, 1.18, -0.2 - swing * 0.28);
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

function animate(): void {
  requestAnimationFrame(animate);
  if (!isPageVisible) {
    return;
  }

  const delta = Math.min(clock.getDelta(), 0.033);
  tickFrame += 1;

  if (state === "playing") {
    updateInput(delta);
    updateEnemies(delta);
    if (tickFrame % 2 === 0) {
      updatePickups(delta);
    }
    updateStorm(delta);
    updateWeapon(delta);
  }

  if (state === "playing" && attackTime > 0) {
    updateSlashEffects(delta);
  }
  updateCamera(delta);
  if (tickFrame % 3 === 0) {
    updateHud();
  }
  renderer.render(scene, camera);
}

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
document.addEventListener("visibilitychange", () => {
  isPageVisible = document.visibilityState === "visible";
});
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
  pointer.x += event.movementX;
  pointer.y += event.movementY;
  cameraYaw -= event.movementX * 0.0024;
  cameraPitch -= event.movementY * 0.0016;
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
equipWeapon(equippedWeapon);
setState("start");
updateCamera(1);
animate();
