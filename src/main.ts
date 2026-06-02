import * as THREE from "three";
import {
  FrameProfiler,
  getRenderQuality,
  type PerformanceTuning,
  type RenderQuality,
} from "./performance";
import "./styles.css";

const ARENA_RADIUS = 86;
const ENEMY_NEAR_SQ = 42 * 42;
const ENEMY_FAR_SQ = 58 * 58;
const PICKUP_INTERACT_SQ = 2.4 * 2.4;

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

type FighterRig = {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  weaponMount: THREE.Group;
};

type Enemy = {
  group: THREE.Group;
  rig: FighterRig;
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
scene.background = new THREE.Color(0x1a3a5c);
// No fog — heavy fog + dark PBR read as an empty navy void on some GPUs.

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  500,
);
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance",
    alpha: false,
  });
} catch (error) {
  app.innerHTML = `<div class="boot-error"><h2>WebGL required</h2><p>${String(error)}</p></div>`;
  throw error;
}
renderer.setClearColor(0x1a3a5c);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.setAttribute("aria-label", "Blade Drop Arena 3D view");
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.sortObjects = false;
app.appendChild(renderer.domElement);

let renderPixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
let shadowFrameCounter = 0;

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
      <div><kbd>P</kbd> profiler</div>
    </div>
  </div>

  <div class="profiler-panel hidden" data-profiler-panel aria-live="polite">
    <div class="profiler-panel__title">Frame profiler</div>
    <pre class="profiler-panel__body" data-profiler-body></pre>
  </div>

  <div class="center-message hidden" data-message></div>

  <div class="start-panel" data-start-panel>
    <p class="desktop-hint hidden" data-desktop-hint>
      You are on the cloud Desktop — this window is the game. Click <strong>Start match</strong> below (not the browser new-tab page).
    </p>
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
const desktopHint = requireHudElement<HTMLElement>("[data-desktop-hint]");

if (new URLSearchParams(window.location.search).get("from") === "desktop") {
  desktopHint.classList.remove("hidden");
}
const profilerPanel = requireHudElement<HTMLElement>("[data-profiler-panel]");
const profilerBody = requireHudElement<HTMLElement>("[data-profiler-body]");

const frameProfiler = new FrameProfiler((lines, fps, frameMs) => {
  profilerBody.textContent = [`FPS ${fps} · frame ${frameMs.toFixed(1)} ms`, "", ...lines].join("\n");
});

const clock = new THREE.Clock();
const world = new THREE.Group();
const props = new THREE.Group();
const enemiesGroup = new THREE.Group();
const pickupsGroup = new THREE.Group();
const slashEffects = new THREE.Group();
scene.add(world, props, enemiesGroup, pickupsGroup, slashEffects);

scene.add(new THREE.AmbientLight(0x9eb8d8, 0.55));
const ambientLight = new THREE.HemisphereLight(0xc8e8ff, 0x3d6b42, 1.35);
scene.add(ambientLight);

const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
sun.position.set(42, 58, 28);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.02;
sun.shadow.camera.near = 8;
sun.shadow.camera.far = 160;
sun.shadow.camera.left = -85;
sun.shadow.camera.right = 85;
sun.shadow.camera.top = 85;
sun.shadow.camera.bottom = -85;

const fillLight = new THREE.DirectionalLight(0x88b8ff, 0.45);
fillLight.position.set(-32, 24, -36);
scene.add(fillLight);

const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x2d8a52,
  roughness: 0.88,
  metalness: 0.02,
  emissive: new THREE.Color(0x143820),
  emissiveIntensity: 0.35,
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

const terrain = new THREE.Mesh(new THREE.CircleGeometry(92, 48), groundMaterial);
terrain.rotation.x = -Math.PI / 2;
terrain.receiveShadow = true;
terrain.frustumCulled = false;
world.add(terrain);

const centerPad = new THREE.Mesh(new THREE.CircleGeometry(22, 40), sandMaterial);
centerPad.position.y = 0.012;
centerPad.rotation.x = -Math.PI / 2;
centerPad.receiveShadow = true;
centerPad.frustumCulled = false;
world.add(centerPad);

const stormRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.8, 48), stormMaterial);
stormRing.rotation.x = -Math.PI / 2;
stormRing.position.y = 0.09;
scene.add(stormRing);

const safeRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.08, 48), safeZoneMaterial);
safeRing.rotation.x = -Math.PI / 2;
safeRing.position.y = 0.12;
scene.add(safeRing);

const playerHeadMaterial = new THREE.MeshStandardMaterial({
  color: 0xf2c5a0,
  roughness: 0.58,
});

const enemyBodyMaterials = [
  new THREE.MeshStandardMaterial({ color: 0xff5e7d, roughness: 0.45, metalness: 0.1 }),
  new THREE.MeshStandardMaterial({ color: 0xff8f4d, roughness: 0.45, metalness: 0.1 }),
  new THREE.MeshStandardMaterial({ color: 0xc46cff, roughness: 0.45, metalness: 0.1 }),
  new THREE.MeshStandardMaterial({ color: 0x5ed6a8, roughness: 0.45, metalness: 0.1 }),
  new THREE.MeshStandardMaterial({ color: 0xffc45e, roughness: 0.45, metalness: 0.1 }),
  new THREE.MeshStandardMaterial({ color: 0x6eb8ff, roughness: 0.45, metalness: 0.1 }),
];

const fighterBodyGeometry = new THREE.CapsuleGeometry(0.48, 1.25, 6, 10);
const fighterHeadGeometry = new THREE.SphereGeometry(0.36, 14, 10);

const player = new THREE.Group();
player.position.set(0, 0, 0);
scene.add(player);

function createFighterRig(
  bodyMaterial: THREE.Material,
  headMaterial: THREE.Material,
  scale = 1,
): FighterRig {
  const root = new THREE.Group();
  root.scale.setScalar(scale);

  const body = new THREE.Mesh(fighterBodyGeometry, bodyMaterial);
  body.position.y = 1.02;
  body.castShadow = true;
  root.add(body);

  const head = new THREE.Mesh(fighterHeadGeometry, headMaterial);
  head.position.y = 1.98;
  head.userData.baseY = head.position.y;
  head.castShadow = true;
  root.add(head);

  body.userData.baseY = body.position.y;

  const weaponMount = new THREE.Group();
  weaponMount.position.set(0.58, 1.18, -0.2);
  root.add(weaponMount);

  return { root, body, head, weaponMount };
}

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
let cameraYaw = 0;
let cameraPitch = 0.52;
let nearestPickup: Pickup | null = null;
let isCanvasAiming = false;
let useDragAim = false;

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
const sharedGeometries = {
  weaponHandle: new THREE.CylinderGeometry(0.055, 0.075, 1, 8),
  weaponTip: new THREE.ConeGeometry(0.16, 0.32, 4),
  weaponAxeHead: new THREE.BoxGeometry(0.24, 0.7, 0.16),
  rock: new THREE.DodecahedronGeometry(1, 0),
  trunk: new THREE.CylinderGeometry(0.25, 0.38, 2.2, 6),
  leaves: new THREE.ConeGeometry(1.2, 2.3, 6),
  wall: new THREE.BoxGeometry(8, 2.8, 0.7),
  slashRing: new THREE.RingGeometry(0.42, 1, 24, 1, -0.55, 1.1),
  fighterBody: fighterBodyGeometry,
  fighterHead: fighterHeadGeometry,
  pickupPlatform: new THREE.CylinderGeometry(0.78, 0.92, 0.18, 12),
  weaponBlades: weapons.map(
    (weapon) => new THREE.BoxGeometry(weapon.bladeLength, 0.12, 0.18),
  ),
};

let slashPoolCursor = 0;

const playerRig = createFighterRig(playerMaterial, playerHeadMaterial, 1);
player.add(playerRig.root);
const playerBody = playerRig.body;
const playerWeapon = playerRig.weaponMount;

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

  const bladeIndex = Math.max(0, weaponIndex);
  const blade = new THREE.Mesh(sharedGeometries.weaponBlades[bladeIndex], bladeMaterial);
  blade.position.x = weapon.bladeLength / 2 + weapon.handleLength / 2;
  blade.castShadow = true;
  weaponGroup.add(blade);

  const tip = new THREE.Mesh(sharedGeometries.weaponTip, bladeMaterial);
  tip.position.x = weapon.bladeLength + weapon.handleLength / 2 + 0.16;
  tip.rotation.z = -Math.PI / 2;
  tip.castShadow = true;
  weaponGroup.add(tip);

  if (weapon.name.includes("Axe")) {
    const axeHead = new THREE.Mesh(sharedGeometries.weaponAxeHead, bladeMaterial);
    axeHead.position.x = weapon.bladeLength + weapon.handleLength / 2 - 0.05;
    axeHead.position.y = 0.22;
    axeHead.castShadow = true;
    weaponGroup.add(axeHead);
  }

  return weaponGroup;
}

const weaponDisplayMeshes = weapons.map((weapon) => createWeaponMesh(weapon));

function equipWeapon(weapon: Weapon): void {
  equippedWeapon = weapon;
  playerWeapon.clear();
  const template = weaponDisplayMeshes[getWeaponIndex(weapon)] ?? weaponDisplayMeshes[0];
  const mesh = template.clone(true);
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

  const bodyMaterial =
    enemyBodyMaterials[Math.floor(Math.random() * enemyBodyMaterials.length)] ??
    enemyBodyMaterials[0];
  const rig = createFighterRig(bodyMaterial, playerHeadMaterial, scale);
  group.add(rig.root);

  const weaponMesh =
    weaponDisplayMeshes[Math.floor(Math.random() * weaponDisplayMeshes.length)].clone(true);
  weaponMesh.rotation.z = -0.15;
  rig.weaponMount.add(weaponMesh);

  enemiesGroup.add(group);

  return {
    group,
    rig,
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

  const weaponMesh = weaponDisplayMeshes[weaponIndex].clone(true);
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
  rocks.computeBoundingSphere();
  rocks.frustumCulled = false;
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
  trunks.computeBoundingSphere();
  foliage.computeBoundingSphere();
  trunks.frustumCulled = false;
  foliage.frustumCulled = false;
  props.add(trunks, foliage);

  const wallCount = 8;
  const walls = new THREE.InstancedMesh(sharedGeometries.wall, stoneMaterial, wallCount);
  walls.castShadow = true;
  walls.receiveShadow = true;
  for (let index = 0; index < wallCount; index += 1) {
    const angle = (index / wallCount) * Math.PI * 2;
    propDummy.position.set(Math.cos(angle) * 18, 1.4, Math.sin(angle) * 18);
    propDummy.rotation.set(0, -angle, 0);
    propDummy.scale.set(1, 1, 1);
    propDummy.updateMatrix();
    walls.setMatrixAt(index, propDummy.matrix);
  }
  walls.instanceMatrix.needsUpdate = true;
  walls.computeBoundingSphere();
  walls.frustumCulled = false;
  props.add(walls);
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

function getViewportSize(): { width: number; height: number } {
  const rect = app!.getBoundingClientRect();
  return {
    width: Math.max(1, Math.floor(rect.width) || window.innerWidth || 320),
    height: Math.max(1, Math.floor(rect.height) || window.innerHeight || 240),
  };
}

function setState(nextState: GameState): void {
  state = nextState;
  startPanel.classList.toggle("hidden", nextState !== "start");
  endPanel.classList.toggle("hidden", nextState !== "ended");
  message.classList.toggle("hidden", nextState !== "playing");
  hud.classList.toggle("hud--playing", nextState === "playing");
  if (nextState === "playing") {
    resize();
    snapGameplayCamera();
    renderer.shadowMap.autoUpdate = true;
    sun.shadow.needsUpdate = true;
  } else {
    renderer.shadowMap.autoUpdate = false;
  }
}

function isPointerLocked(): boolean {
  return document.pointerLockElement === renderer.domElement;
}

function requestGamePointerLock(): void {
  renderer.domElement.requestPointerLock().catch(() => {
    useDragAim = true;
    message.textContent = "Drag on the arena to aim";
    message.classList.remove("hidden");
  });
}

function setMenuCamera(): void {
  camera.position.set(52, 38, 52);
  camera.lookAt(0, 1.2, 0);
}

function snapGameplayCamera(): void {
  cameraPitch = THREE.MathUtils.clamp(cameraPitch, 0.35, 0.72);
  const radius = 8.4;
  const height = 3.2 + cameraPitch * 4.5;
  cameraTarget.copy(player.position).add(new THREE.Vector3(0, 1.45, 0));
  camera.position.set(
    player.position.x - Math.sin(cameraYaw) * radius,
    player.position.y + height,
    player.position.z - Math.cos(cameraYaw) * radius,
  );
  camera.lookAt(cameraTarget);
}

function startMatch(): void {
  spawnMatch();
  snapGameplayCamera();
  setState("playing");
  useDragAim = false;
  isCanvasAiming = false;
  message.textContent = "Click or drag the arena to aim · WASD to move";
  message.classList.remove("hidden");
  requestGamePointerLock();
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
  const slash = slashPool[slashPoolCursor];
  slashPoolCursor = (slashPoolCursor + 1) % SLASH_POOL_SIZE;

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
  if (distanceFromCenter > ARENA_RADIUS) {
    player.position.multiplyScalar(ARENA_RADIUS / distanceFromCenter);
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
  if (state !== "playing") {
    setMenuCamera();
    return;
  }

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

function updateEnemies(delta: number, tuning: PerformanceTuning): void {
  const playerX = player.position.x;
  const playerZ = player.position.z;
  const aiFrame = tickFrame % tuning.enemyAiInterval === 0;
  const animFrame = tickFrame % tuning.enemyAnimInterval === 0;
  const bobPhase = clock.elapsedTime * 4;

  for (const enemy of enemies) {
    enemy.cooldown = Math.max(0, enemy.cooldown - delta);
    enemy.stun = Math.max(0, enemy.stun - delta);

    const offsetX = playerX - enemy.group.position.x;
    const offsetZ = playerZ - enemy.group.position.z;
    const distSq = offsetX * offsetX + offsetZ * offsetZ;

    if (distSq > ENEMY_FAR_SQ) {
      if (aiFrame) {
        const distFromCenter = Math.hypot(enemy.group.position.x, enemy.group.position.z);
        if (distFromCenter > stormRadius - 2) {
          tempVectorTwo.copy(enemy.group.position).multiplyScalar(-1).normalize();
          enemy.group.position.addScaledVector(tempVectorTwo, enemy.speed * delta * 1.25);
        }
      }
      continue;
    }

    if (!aiFrame && distSq > ENEMY_NEAR_SQ) {
      continue;
    }

    const distance = Math.sqrt(distSq);
    tempVector.set(offsetX, 0, offsetZ);
    const direction = distance > 0.001 ? tempVector.multiplyScalar(1 / distance) : tempVector.set(0, 0, 1);
    enemy.group.rotation.y = Math.atan2(direction.x, direction.z);

    if (enemy.stun <= 0) {
      if (distance > 1.45) {
        enemy.group.position.addScaledVector(direction, enemy.speed * delta * tuning.enemyAiInterval);
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

    if (animFrame && distSq < ENEMY_NEAR_SQ) {
      const bob =
        Math.sin(bobPhase + enemy.group.position.x + enemy.group.position.z) * 0.0008;
      const body = enemy.rig.body;
      const head = enemy.rig.head;
      body.position.y = (body.userData.baseY as number) + bob;
      head.position.y = (head.userData.baseY as number) + bob;
    }
  }
}

function updatePickups(delta: number, tuning: PerformanceTuning, updateMessage: boolean): void {
  let nearestDistanceSq = Number.POSITIVE_INFINITY;
  nearestPickup = null;

  const playerX = player.position.x;
  const playerZ = player.position.z;
  const bobTime = clock.elapsedTime * 2.4;
  const animatePickups = tickFrame % tuning.pickupInterval === 0;

  for (const pickup of pickups) {
    if (animatePickups) {
      pickup.group.rotation.y += delta * 1.6 * tuning.pickupInterval;
      pickup.group.position.y = 0.72 + Math.sin(bobTime + pickup.bobOffset) * 0.18;
    }
    const dx = pickup.group.position.x - playerX;
    const dz = pickup.group.position.z - playerZ;
    const distSq = dx * dx + dz * dz;
    if (distSq < PICKUP_INTERACT_SQ && distSq < nearestDistanceSq) {
      nearestDistanceSq = distSq;
      nearestPickup = pickup;
    }
  }

  if (!updateMessage) {
    return;
  }

  if (nearestPickup) {
    message.textContent = `Press E to pick up ${nearestPickup.weapon.name}`;
    message.classList.remove("hidden");
  } else if (state === "playing") {
    if (useDragAim && !isCanvasAiming) {
      message.textContent = "Drag on the arena to aim";
      message.classList.remove("hidden");
    } else if (isPointerLocked()) {
      message.textContent = "Outlast the arena";
      message.classList.add("hidden");
    } else {
      message.textContent = "Click or drag the arena to aim";
      message.classList.remove("hidden");
    }
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

function applyRenderQuality(): RenderQuality {
  const quality = getRenderQuality(frameProfiler.fps);
  const nextRatio = Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap);
  if (Math.abs(nextRatio - renderPixelRatio) > 0.04) {
    renderPixelRatio = nextRatio;
    renderer.setPixelRatio(renderPixelRatio);
  }
  const shadowSize = quality.shadowMapSize;
  if (sun.shadow.mapSize.x !== shadowSize) {
    sun.shadow.mapSize.set(shadowSize, shadowSize);
  }
  return quality;
}

function animate(): void {
  requestAnimationFrame(animate);
  if (!isPageVisible) {
    return;
  }

  frameProfiler.beginFrame();
  const delta = Math.min(clock.getDelta(), 0.033);
  tickFrame += 1;
  const quality = applyRenderQuality();
  const tuning = quality.tuning;

  if (state === "playing") {
    frameProfiler.measure("input", () => updateInput(delta));
    frameProfiler.measure("enemies", () => updateEnemies(delta, tuning));
    frameProfiler.measure("pickups", () =>
      updatePickups(
        delta,
        tuning,
        tickFrame % tuning.messageInterval === 0,
      ),
    );
    frameProfiler.measure("storm", () => updateStorm(delta));
    frameProfiler.measure("weapon", () => updateWeapon(delta));
  }

  if (state === "playing" && attackTime > 0) {
    frameProfiler.measure("slash", () => updateSlashEffects(delta));
  }
  frameProfiler.measure("camera", () => updateCamera(delta));
  if (tickFrame % tuning.hudInterval === 0) {
    frameProfiler.measure("hud", () => updateHud());
  }

  if (state === "playing" && !renderer.shadowMap.autoUpdate) {
    shadowFrameCounter += 1;
    if (shadowFrameCounter >= tuning.shadowInterval) {
      shadowFrameCounter = 0;
      sun.shadow.needsUpdate = true;
    }
  }

  frameProfiler.measure("render", () => {
    renderer.render(scene, camera);
  });
  frameProfiler.endFrame();
}

function resize(): void {
  const { width, height } = getViewportSize();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(renderPixelRatio);
  renderer.setSize(width, height, false);
}

window.addEventListener("resize", resize);
if (typeof ResizeObserver !== "undefined") {
  const viewportObserver = new ResizeObserver(() => resize());
  viewportObserver.observe(app);
}
renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  message.textContent = "WebGL context lost — refresh the page";
  message.classList.remove("hidden");
});
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
  if (event.code === "KeyP") {
    const show = !frameProfiler.visible;
    frameProfiler.setVisible(show);
    profilerPanel.classList.toggle("hidden", !show);
  }
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});
function applyMouseLook(movementX: number, movementY: number): void {
  cameraYaw -= movementX * 0.0024;
  cameraPitch -= movementY * 0.0016;
}

window.addEventListener("mousemove", (event) => {
  if (!isPointerLocked()) {
    return;
  }
  pointer.x += event.movementX;
  pointer.y += event.movementY;
  applyMouseLook(event.movementX, event.movementY);
});

window.addEventListener("mouseup", () => {
  isCanvasAiming = false;
});

renderer.domElement.addEventListener("mousemove", (event) => {
  if (state !== "playing" || isPointerLocked()) {
    return;
  }
  if (!isCanvasAiming && !useDragAim) {
    return;
  }
  applyMouseLook(event.movementX, event.movementY);
});

renderer.domElement.addEventListener("mousedown", (event) => {
  if (state !== "playing" || event.button !== 0) {
    return;
  }
  isCanvasAiming = true;
  if (!isPointerLocked()) {
    requestGamePointerLock();
  }
  attack();
});

startButton.addEventListener("click", (event) => {
  event.stopPropagation();
  startMatch();
});
restartButton.addEventListener("click", (event) => {
  event.stopPropagation();
  startMatch();
});
renderer.domElement.addEventListener("click", () => {
  if (state === "playing" && !isPointerLocked()) {
    requestGamePointerLock();
  }
});

addProps();
equipWeapon(equippedWeapon);
resize();
setState("start");
setMenuCamera();
sun.shadow.needsUpdate = true;
renderer.render(scene, camera);
animate();
