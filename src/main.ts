import * as THREE from "three";
import {
  animateHumanoid,
  applyAttackPose,
  createHumanoid,
  setHumanoidFlash,
  type HumanoidPalette,
  type HumanoidRig,
} from "./humanoid";
import { createHumanoidPalette } from "./humanoidMaterials";
import {
  addSkyDome,
  configureRenderer,
  createBlobShadowTexture,
  setupLighting,
  syncSunShadowQuality,
} from "./graphics";
import { FortnitePostPipeline, getPostFxQuality } from "./postProcessing";
import { FpsMeter } from "./fpsMeter";
import { ArenaMinimap } from "./minimap";
import {
  applyAdaptivePixelRatio,
  getEffectiveFps,
  getRenderQuality,
  resetGraphicsSyncState,
  syncEnvironmentRendering,
  syncShadowRendering,
  type PerformanceTuning,
  type RenderQuality,
} from "./performance";
import { createBackdropScenery } from "./scenery";
import {
  createLootTowers,
  findNearestTower,
  findTowerPlayerIsInside,
  getTowerLootWorldPosition,
  resolveTowerWallCollision,
  type LootTower,
} from "./lootTowers";
import {
  ARENA_RADIUS,
  createArenaTerrain,
  sampleTerrainHeight,
  STORM_MIN_RADIUS,
  STORM_START_RADIUS,
} from "./terrain";
import { applyTerrainTextureAnisotropy } from "./terrainTextures";
import {
  addWeaponToInventory,
  consumeSlot,
  createStarterInventory,
  getEntryIcon,
  getEntryLabel,
  getWeaponInSlot,
  INVENTORY_SLOTS,
  isBuffItem,
  type InventorySlot,
} from "./inventory";
import { BuffController, getBuffLabel } from "./playerBuffs";
import { purchaseListing, SHOP_LISTINGS } from "./shop";
import { getWeaponIndex, WEAPONS, type Weapon } from "./weapons";
import "./styles.css";

type GameSession = {
  initialized: boolean;
  state: GameState;
  shards: number;
  inventory: InventorySlot[];
  selectedSlot: number;
};

function getSession(): GameSession {
  const root = window as Window & { __bladeArenaSession?: GameSession };
  if (!root.__bladeArenaSession) {
    root.__bladeArenaSession = {
      initialized: false,
      state: "start",
      shards: 120,
      inventory: createStarterInventory(),
      selectedSlot: 0,
    };
  }
  const existing = root.__bladeArenaSession;
  if (!existing.inventory) {
    existing.inventory = createStarterInventory();
  }
  if (existing.shards === undefined) {
    existing.shards = 120;
  }
  if (existing.selectedSlot === undefined) {
    existing.selectedSlot = 0;
  }
  return existing;
}
const ATTACK_CHARGE_TIME = 2;
const CHARGED_DAMAGE_MULTIPLIER = 2.85;
const CHARGED_RANGE_MULTIPLIER = 1.22;
const CHARGED_KNOCKBACK_MULTIPLIER = 1.65;

type GameState = "start" | "playing" | "ended";

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
  baseY: number;
  towerLoot: boolean;
};

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Unable to find app container.");
}

const app = appRoot;

function isEmbeddedPreview(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function resetPreviewSession(): void {
  if (!isEmbeddedPreview()) {
    return;
  }
  const root = window as Window & { __bladeArenaSession?: GameSession };
  delete root.__bladeArenaSession;
}

function getViewportSize(): { width: number; height: number } {
  const rect = app.getBoundingClientRect();
  const width = Math.max(
    Math.floor(rect.width) || 0,
    document.documentElement.clientWidth || 0,
    window.innerWidth || 0,
    320,
  );
  const height = Math.max(
    Math.floor(rect.height) || 0,
    document.documentElement.clientHeight || 0,
    window.innerHeight || 0,
    240,
  );
  return { width, height };
}

function showBootError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const panel = document.createElement("div");
  panel.className = "boot-error";
  panel.innerHTML = `
    <h2>Blade Arena could not start</h2>
    <p>${detail.replace(/</g, "&lt;")}</p>
    <p>Run <code>npm run dev</code>, open <strong>Chrome</strong> on the Desktop taskbar, then go to <strong>http://localhost:5173/</strong></p>
    <p>The Desktop tab is the VM desktop (wallpaper), not the game embedded in the pane.</p>
  `;
  app.replaceChildren(panel);
}

let bootComplete = false;

function installBootErrorHandlers(): void {
  window.addEventListener("error", (event) => {
    if (bootComplete || event.defaultPrevented) {
      return;
    }
    console.error(event.error ?? event.message);
    showBootError(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (bootComplete) {
      return;
    }
    console.error(event.reason);
    showBootError(event.reason);
  });
}

resetPreviewSession();
installBootErrorHandlers();

const scene = new THREE.Scene();

const initialViewport = getViewportSize();
const camera = new THREE.PerspectiveCamera(
  58,
  initialViewport.width / initialViewport.height,
  0.1,
  420,
);

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance",
    failIfMajorPerformanceCaveat: false,
  });
} catch (error) {
  showBootError(error);
  throw error;
}

renderer.setSize(initialViewport.width, initialViewport.height);
let renderPixelRatio = Math.min(window.devicePixelRatio || 1, 0.85);
renderer.setPixelRatio(renderPixelRatio);
configureRenderer(renderer);
renderer.domElement.classList.add("game-canvas");
renderer.domElement.setAttribute("aria-label", "Blade Arena arena view");
app.querySelector(".boot-loading")?.remove();
app.appendChild(renderer.domElement);

const gameCursor = document.createElement("div");
gameCursor.className = "game-cursor hidden";
gameCursor.setAttribute("aria-hidden", "true");
app.appendChild(gameCursor);

const aimReticle = document.createElement("div");
aimReticle.className = "aim-reticle hidden";
aimReticle.setAttribute("aria-hidden", "true");
aimReticle.innerHTML = `
  <span class="aim-reticle__ring"></span>
  <span class="aim-reticle__tick aim-reticle__tick--n"></span>
  <span class="aim-reticle__tick aim-reticle__tick--s"></span>
  <span class="aim-reticle__tick aim-reticle__tick--e"></span>
  <span class="aim-reticle__tick aim-reticle__tick--w"></span>
  <span class="aim-reticle__dot"></span>
`;
app.appendChild(aimReticle);

const horizonColor = addSkyDome(scene);
scene.background = horizonColor.clone();
scene.fog = new THREE.FogExp2(horizonColor.getHex(), 0.0032);
const sunLight = setupLighting(scene);
const postPipeline = new FortnitePostPipeline(renderer, scene, camera);

const hud = document.createElement("div");
hud.className = "hud";
hud.innerHTML = `
  <div class="fps-panel" data-fps-panel aria-live="polite">
    <span class="fps-panel__label">Redraw</span>
    <span class="fps-panel__value">FPS: <strong data-fps-value>--</strong></span>
    <span class="fps-panel__ms" data-fps-ms></span>
  </div>

  <div class="top-bar">
    <div class="stat"><span>Health</span><strong data-health>100</strong></div>
    <div class="stat stat--currency"><span>Shards</span><strong data-shards>120</strong></div>
    <div class="stat"><span>Alive</span><strong data-alive>12</strong></div>
    <div class="stat"><span>Elims</span><strong data-score>0</strong></div>
    <div class="stat"><span>Storm</span><strong data-storm>90m</strong></div>
  </div>

  <div class="buff-bar hidden" data-buff-bar aria-label="Active buffs"></div>

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
      <div><kbd>Space</kbd> jump</div>
      <div><kbd>E</kbd> pick up</div>
      <div><kbd>1-5</kbd> inventory</div>
      <div><kbd>B</kbd> shop</div>
      <div><kbd>R</kbd> restart</div>
    </div>
  </div>

  <div class="inventory-bar" data-inventory-bar aria-label="Inventory">
    <button type="button" class="inventory-slot inventory-slot--active" data-inv-slot="0">
      <span class="inventory-slot__key">1</span>
      <span class="inventory-slot__icon" data-inv-icon>⚔</span>
      <span class="inventory-slot__name" data-inv-name>Storm Knife</span>
      <span class="inventory-slot__qty hidden" data-inv-qty></span>
    </button>
    <button type="button" class="inventory-slot" data-inv-slot="1">
      <span class="inventory-slot__key">2</span>
      <span class="inventory-slot__icon" data-inv-icon>·</span>
      <span class="inventory-slot__name" data-inv-name>Empty</span>
      <span class="inventory-slot__qty hidden" data-inv-qty></span>
    </button>
    <button type="button" class="inventory-slot" data-inv-slot="2">
      <span class="inventory-slot__key">3</span>
      <span class="inventory-slot__icon" data-inv-icon>·</span>
      <span class="inventory-slot__name" data-inv-name>Empty</span>
      <span class="inventory-slot__qty hidden" data-inv-qty></span>
    </button>
    <button type="button" class="inventory-slot" data-inv-slot="3">
      <span class="inventory-slot__key">4</span>
      <span class="inventory-slot__icon" data-inv-icon>·</span>
      <span class="inventory-slot__name" data-inv-name>Empty</span>
      <span class="inventory-slot__qty hidden" data-inv-qty></span>
    </button>
    <button type="button" class="inventory-slot" data-inv-slot="4">
      <span class="inventory-slot__key">5</span>
      <span class="inventory-slot__icon" data-inv-icon>·</span>
      <span class="inventory-slot__name" data-inv-name>Empty</span>
      <span class="inventory-slot__qty hidden" data-inv-qty></span>
    </button>
  </div>

  <div class="shop-panel hidden" data-shop-panel>
    <div class="shop-panel__backdrop" data-shop-close></div>
    <div class="shop-panel__card">
      <header class="shop-panel__header">
        <div>
          <p class="shop-panel__eyebrow">Valley merchant</p>
          <h2 class="shop-panel__title">Arena Shop</h2>
        </div>
        <div class="shop-panel__balance">Shards: <strong data-shop-shards>0</strong></div>
        <button type="button" class="shop-panel__close" data-shop-close aria-label="Close shop">×</button>
      </header>
      <p class="shop-panel__hint" data-shop-toast>Buy weapons, heals, and buffs. Loot fills your 5 slots.</p>
      <div class="shop-panel__grid" data-shop-grid></div>
    </div>
  </div>

  <div class="minimap-panel hidden" data-minimap-panel>
    <span class="minimap-panel__label">Map</span>
    <canvas class="minimap-panel__canvas" data-minimap width="96" height="96" aria-label="Arena map"></canvas>
  </div>

  <div class="center-message hidden" data-message></div>

  <div class="title-screen start-panel" data-start-panel>
    <div class="title-screen__cinema" aria-hidden="true">
      <div class="title-screen__backdrop"></div>
      <div class="title-screen__aurora"></div>
      <div class="title-screen__grid"></div>
      <div class="title-screen__arena-glow"></div>
      <div class="title-screen__ring"></div>
      <div class="title-screen__scanlines"></div>
      <div class="title-screen__vignette"></div>
      <div class="title-screen__sparks">
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
        <span class="title-screen__spark"></span>
      </div>
      <div class="title-screen__slash title-screen__slash--a"></div>
      <div class="title-screen__slash title-screen__slash--b"></div>
      <div class="title-screen__orb title-screen__orb--left"></div>
      <div class="title-screen__orb title-screen__orb--right"></div>
    </div>
    <div class="title-screen__layout">
      <aside class="title-screen__rail title-screen__rail--left" aria-hidden="true">
        <span>Loot</span>
        <span>Charge</span>
        <span>Survive</span>
      </aside>
      <div class="title-screen__content">
        <p class="title-screen__eyebrow">
          <span class="title-screen__eyebrow-dot"></span>
          Live melee battle royale
        </p>
        <h1 class="title-screen__logo">
          <span class="title-screen__logo-line">Blade</span>
          <span class="title-screen__logo-line title-screen__logo-line--accent">Arena</span>
        </h1>
        <p class="title-screen__tagline">
          Drop into a living valley arena. Outposition rivals, steal their weapons, and cut through
          the storm before it swallows you.
        </p>
        <div class="title-screen__stats">
          <div class="title-screen__stat">
            <strong>12</strong>
            <span>Fighters</span>
          </div>
          <div class="title-screen__stat">
            <strong>4</strong>
            <span>Blades</span>
          </div>
          <div class="title-screen__stat">
            <strong>1</strong>
            <span>Storm</span>
          </div>
        </div>
        <ul class="title-screen__features">
          <li><kbd>RMB</kbd> move</li>
          <li><kbd>Drag</kbd> aim</li>
          <li><kbd>A</kbd> charge slash</li>
          <li><kbd>Space</kbd> jump</li>
        </ul>
        <div class="title-screen__cta-wrap">
          <button class="title-screen__cta" type="button" data-start-button>
            <span class="title-screen__cta-ring" aria-hidden="true"></span>
            <span class="title-screen__cta-text">Enter the Arena</span>
            <span class="title-screen__cta-shine" aria-hidden="true"></span>
          </button>
        </div>
        <p class="title-screen__hint">Shop on the right · <kbd>B</kbd> in-game · <kbd>1-5</kbd> inventory</p>
      </div>
      <div class="title-screen__side title-screen__side--right">
        <button type="button" class="title-screen__shop-btn" data-title-shop-button>
          <span class="title-screen__shop-btn-glow" aria-hidden="true"></span>
          <span class="title-screen__shop-btn-icon" aria-hidden="true">◆</span>
          <span class="title-screen__shop-btn-label">Arena Shop</span>
          <span class="title-screen__shop-btn-sub">Weapons · buffs · heals</span>
          <span class="title-screen__shop-btn-shards">
            <span data-title-shop-shards>120</span> shards
          </span>
        </button>
      </div>
    </div>
  </div>

  <div class="result-screen end-panel hidden" data-end-panel>
    <div class="title-screen__backdrop" aria-hidden="true"></div>
    <div class="result-screen__content">
      <p class="title-screen__eyebrow">Blade Arena</p>
      <h2 class="result-screen__title" data-end-title>Match over</h2>
      <p class="result-screen__copy" data-end-copy></p>
      <button class="title-screen__cta" type="button" data-restart-button>Play again</button>
    </div>
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
const titleShopButton = requireHudElement<HTMLButtonElement>("[data-title-shop-button]");
const titleShopShardsText = requireHudElement<HTMLElement>("[data-title-shop-shards]");
const fpsPanel = requireHudElement<HTMLElement>("[data-fps-panel]");
const fpsValueText = requireHudElement<HTMLElement>("[data-fps-value]");
const fpsMsText = requireHudElement<HTMLElement>("[data-fps-ms]");
const shardsText = requireHudElement<HTMLElement>("[data-shards]");
const buffBar = requireHudElement<HTMLElement>("[data-buff-bar]");
const inventoryBar = requireHudElement<HTMLElement>("[data-inventory-bar]");
const shopPanel = requireHudElement<HTMLElement>("[data-shop-panel]");
const shopShardsText = requireHudElement<HTMLElement>("[data-shop-shards]");
const shopToast = requireHudElement<HTMLElement>("[data-shop-toast]");
const shopGrid = requireHudElement<HTMLElement>("[data-shop-grid]");
const minimapPanel = requireHudElement<HTMLElement>("[data-minimap-panel]");
const minimapCanvas = requireHudElement<HTMLCanvasElement>("[data-minimap]");

const inventorySlotButtons = Array.from(
  inventoryBar.querySelectorAll<HTMLButtonElement>("[data-inv-slot]"),
);
const inventorySlotIcons = inventorySlotButtons.map(
  (button) => button.querySelector<HTMLElement>("[data-inv-icon]")!,
);
const inventorySlotNames = inventorySlotButtons.map(
  (button) => button.querySelector<HTMLElement>("[data-inv-name]")!,
);
const inventorySlotQty = inventorySlotButtons.map(
  (button) => button.querySelector<HTMLElement>("[data-inv-qty]")!,
);

const session = getSession();
const playerBuffs = new BuffController();
let shopOpen = false;
const arenaMinimap = new ArenaMinimap(minimapCanvas, ARENA_RADIUS);
const fpsMeter = new FpsMeter((fps, meta) => {
  fpsValueText.textContent = String(fps);
  fpsMsText.textContent = `${meta.frameMs} ms/frame`;
  fpsPanel.title = meta.embedded
    ? `Actual game redraw rate (${fps} FPS). The Desktop pane often caps this near 15 — open http://localhost:5173 in Chrome for higher FPS.`
    : `Actual game redraw rate (${fps} FPS, ${meta.frameMs} ms per frame).`;
});

const clock = new THREE.Clock();
const world = new THREE.Group();
const props = new THREE.Group();
const enemiesGroup = new THREE.Group();
const pickupsGroup = new THREE.Group();
const slashEffects = new THREE.Group();
scene.add(world, props, enemiesGroup, pickupsGroup, slashEffects);

const sharedGeometries = {
  stormRing: new THREE.RingGeometry(1, 1.8, 16),
  weaponHandle: new THREE.CylinderGeometry(0.055, 0.075, 1, 6),
  weaponBlade: new THREE.BoxGeometry(1, 0.1, 0.16),
  weaponTip: new THREE.ConeGeometry(0.14, 0.28, 4),
  rock: new THREE.DodecahedronGeometry(1, 0),
  treeFoliage: new THREE.ConeGeometry(1.05, 2.4, 5),
  treeTrunk: new THREE.CylinderGeometry(0.16, 0.22, 1.1, 4),
  pickupPlatform: new THREE.CylinderGeometry(0.78, 0.92, 0.18, 8),
  slashRing: new THREE.RingGeometry(0.42, 1, 12, 1, -0.55, 1.1),
};

function createSurfaceMaterial(
  color: THREE.ColorRepresentation,
  roughness = 0.68,
  metalness = 0.08,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    envMapIntensity: 0.72,
  });
}

const stoneMaterial = createSurfaceMaterial(0x7a8088, 0.82, 0.06);
const treeTrunkMaterial = createSurfaceMaterial(0x4a3528, 0.88, 0.02);
const treeFoliageMaterial = new THREE.MeshStandardMaterial({
  color: 0x356840,
  roughness: 0.78,
  metalness: 0.02,
  emissive: new THREE.Color(0x142818),
  emissiveIntensity: 0.05,
  envMapIntensity: 0.5,
});
const playerPalette: HumanoidPalette = createHumanoidPalette({
  skinColor: 0xe8b896,
  shirtColor: 0x3d5568,
  pantsColor: 0x252c34,
  bootsColor: 0x1a1410,
  hairColor: 0x3a2c22,
});
const enemyPalette: HumanoidPalette = createHumanoidPalette({
  skinColor: 0xd4a480,
  shirtColor: 0x6a3038,
  pantsColor: 0x241c1e,
  bootsColor: 0x120e0e,
  hairColor: 0x1e1614,
});
const gripMaterial = createSurfaceMaterial(0x221c18, 0.82, 0.08);
const stormMaterial = new THREE.MeshBasicMaterial({
  color: 0x7a5ad8,
  transparent: true,
  opacity: 0.2,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const weaponBladeMaterials = WEAPONS.map(
  (weapon) =>
    new THREE.MeshStandardMaterial({
      color: weapon.color,
      roughness: 0.18,
      metalness: 0.88,
      emissive: weapon.color,
      emissiveIntensity: 0.14,
      envMapIntensity: 1.22,
    }),
);

const arenaTerrain = createArenaTerrain();
applyTerrainTextureAnisotropy(renderer);
world.add(arenaTerrain.mesh);
const lootTowers: LootTower[] = createLootTowers(world);
const towerLootPosition = new THREE.Vector3();
const towerCollisionScratch = new THREE.Vector2();
const backdropScenery = createBackdropScenery();
backdropScenery.visible = false;
scene.add(backdropScenery);

const playerBlobShadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 16),
  new THREE.MeshBasicMaterial({
    map: createBlobShadowTexture(),
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  }),
);
playerBlobShadow.rotation.x = -Math.PI / 2;
playerBlobShadow.renderOrder = -1;
scene.add(playerBlobShadow);

const moveMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.52, 16),
  new THREE.MeshBasicMaterial({
    color: 0x9ee8ff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
moveMarker.rotation.x = -Math.PI / 2;
moveMarker.visible = false;
scene.add(moveMarker);

const stormRing = new THREE.Mesh(sharedGeometries.stormRing, stormMaterial);
stormRing.rotation.x = -Math.PI / 2;
stormRing.position.y = 0.09;
scene.add(stormRing);

const player = new THREE.Group();
scene.add(player);

const playerHumanoid = createHumanoid(playerPalette, 1, true);
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

let state: GameState = getSession().state;
let playerHealth = 100;
let score = 0;
let equippedWeapon = WEAPONS[0];
let equippedWeaponIndex = 0;
let attackCooldown = 0;
let attackTime = 0;
let attackAnimDuration = 0.26;
let verticalVelocity = 0;
let isGrounded = true;
const JUMP_VELOCITY = 8.6;
const GRAVITY = 27;
let invulnerable = 0;
let stormRadius = STORM_START_RADIUS;
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
  shards: -1,
  healthScale: -1,
  cooldownScale: -1,
  chargeScale: -1,
};

function getInventory(): InventorySlot[] {
  return session.inventory;
}

function syncEquippedFromSelectedSlot(): void {
  const weapon = getWeaponInSlot(session.inventory, session.selectedSlot) ?? WEAPONS[0];
  equipWeapon(weapon);
}

function renderInventoryHud(): void {
  const slots = getInventory();
  for (let index = 0; index < INVENTORY_SLOTS; index += 1) {
    const entry = slots[index];
    const button = inventorySlotButtons[index];
    const icon = inventorySlotIcons[index];
    const name = inventorySlotNames[index];
    const qty = inventorySlotQty[index];
    button.classList.toggle("inventory-slot--active", index === session.selectedSlot);
    button.classList.toggle("inventory-slot--empty", !entry);
    if (!entry) {
      icon.textContent = "·";
      name.textContent = "Empty";
      qty.classList.add("hidden");
      qty.textContent = "";
      continue;
    }
    icon.textContent = getEntryIcon(entry);
    name.textContent = getEntryLabel(entry);
    if (entry.kind === "stackable" && entry.quantity > 1) {
      qty.textContent = String(entry.quantity);
      qty.classList.remove("hidden");
    } else {
      qty.classList.add("hidden");
      qty.textContent = "";
    }
  }
}

function renderBuffHud(): void {
  if (playerBuffs.active.length === 0) {
    buffBar.classList.add("hidden");
    buffBar.replaceChildren();
    return;
  }
  buffBar.classList.remove("hidden");
  buffBar.replaceChildren(
    ...playerBuffs.active.map((buff) => {
      const chip = document.createElement("span");
      chip.className = "buff-chip";
      chip.textContent = `${getBuffLabel(buff.id)} ${Math.ceil(buff.remaining)}s`;
      return chip;
    }),
  );
}

function buildShopGrid(): void {
  shopGrid.replaceChildren(
    ...SHOP_LISTINGS.map((listing) => {
      const card = document.createElement("article");
      card.className = "shop-card";
      card.innerHTML = `
        <span class="shop-card__category">${listing.category}</span>
        <h3 class="shop-card__name">${listing.name}</h3>
        <p class="shop-card__desc">${listing.description}</p>
        <div class="shop-card__footer">
          <span class="shop-card__price">${listing.price} shards</span>
          <button type="button" class="shop-card__buy">Buy</button>
        </div>
      `;
      const buy = card.querySelector<HTMLButtonElement>(".shop-card__buy");
      buy?.addEventListener("click", () => {
        const { result, shards } = purchaseListing(listing, session.shards, session.inventory);
        session.shards = shards;
        shopToast.textContent = result.message;
        syncShopShardLabels();
        shardsText.textContent = String(session.shards);
        hudCache.shards = -1;
        renderInventoryHud();
        if (result.ok && listing.category === "weapon") {
          syncEquippedFromSelectedSlot();
        }
      });
      return card;
    }),
  );
}

function syncShopShardLabels(): void {
  const label = String(session.shards);
  shopShardsText.textContent = label;
  titleShopShardsText.textContent = label;
}

function setShopOpen(open: boolean): void {
  shopOpen = open;
  shopPanel.classList.toggle("hidden", !open);
  hud.classList.toggle("hud--shop-open", open);
  startPanel.classList.toggle("title-screen--shop-open", open && state === "start");
  if (open) {
    syncShopShardLabels();
    shopToast.textContent = "Spend shards on gear before you drop in, or mid-match.";
  }
}

function toggleShop(): void {
  setShopOpen(!shopOpen);
}

function useInventorySlot(slotIndex: number): void {
  if (slotIndex < 0 || slotIndex >= INVENTORY_SLOTS) {
    return;
  }
  const entry = getInventory()[slotIndex];
  if (!entry) {
    session.selectedSlot = slotIndex;
    syncEquippedFromSelectedSlot();
    renderInventoryHud();
    return;
  }

  if (entry.kind === "weapon") {
    session.selectedSlot = slotIndex;
    syncEquippedFromSelectedSlot();
    renderInventoryHud();
    return;
  }

  if (state !== "playing") {
    session.selectedSlot = slotIndex;
    renderInventoryHud();
    return;
  }

  const consumed = consumeSlot(getInventory(), slotIndex);
  if (!consumed || consumed.kind !== "stackable") {
    return;
  }

  if (consumed.itemId === "medkit") {
    playerHealth = Math.min(100, playerHealth + 35);
  } else if (consumed.itemId === "mega_medkit") {
    playerHealth = Math.min(100, playerHealth + 70);
  } else if (isBuffItem(consumed.itemId)) {
    playerBuffs.applyBuff(consumed.itemId);
  }

  renderInventoryHud();
  renderBuffHud();
  hudCache.health = -1;
}

buildShopGrid();
renderInventoryHud();
setShopOpen(false);

const SLASH_POOL_SIZE = 2;
const ENEMY_UPDATE_NEAR = 42;
let tickFrame = 0;
let cachedRenderQuality: RenderQuality = getRenderQuality(72);
let isCanvasAiming = false;
let useDragAim = false;
const slashPool: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];

for (let index = 0; index < SLASH_POOL_SIZE; index += 1) {
  const slashMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const slash = new THREE.Mesh(sharedGeometries.slashRing, slashMaterial);
  slash.visible = false;
  slash.rotation.x = -Math.PI / 2;
  slash.userData.life = 0;
  slashEffects.add(slash);
  slashPool.push(slash);
}

function snapToGround(object: THREE.Object3D): void {
  object.position.y = sampleTerrainHeight(object.position.x, object.position.z);
}

function applyPlayerJumpPhysics(delta: number): void {
  const groundY = sampleTerrainHeight(player.position.x, player.position.z);

  if (!isGrounded || verticalVelocity > 0.01) {
    verticalVelocity -= GRAVITY * delta;
    player.position.y += verticalVelocity * delta;

    if (player.position.y <= groundY) {
      player.position.y = groundY;
      verticalVelocity = 0;
      isGrounded = true;
    }
  } else {
    player.position.y = groundY;
    isGrounded = true;
  }
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

  const humanoid = createHumanoid(enemyPalette, scale, true);
  group.add(humanoid.root);

  const weapon = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
  const weaponMesh = createWeaponMesh(weapon);
  weaponMesh.rotation.z = -0.15;
  weaponMesh.scale.setScalar(scale);
  humanoid.weaponMount.add(weaponMesh);

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

function createPickup(
  weapon: Weapon,
  x: number,
  z: number,
  options?: { towerLoot?: boolean; worldY?: number },
): Pickup {
  const group = new THREE.Group();
  const groundY = sampleTerrainHeight(x, z);
  const towerLoot = options?.towerLoot ?? false;
  const baseY = options?.worldY ?? groundY + 0.55;
  group.position.set(x, baseY, z);
  group.userData.towerLoot = towerLoot;
  const weaponIndex = getWeaponIndex(weapon);

  const platform = new THREE.Mesh(
    sharedGeometries.pickupPlatform,
    weaponBladeMaterials[weaponIndex] ?? weaponBladeMaterials[0],
  );
  platform.castShadow = true;
  group.add(platform);

  const pickupBlade = new THREE.Mesh(
    sharedGeometries.weaponBlade,
    weaponBladeMaterials[weaponIndex] ?? weaponBladeMaterials[0],
  );
  pickupBlade.scale.set(weapon.bladeLength * 0.85, 1, 1);
  pickupBlade.position.y = 0.42;
  pickupBlade.rotation.z = 0.65;
  group.add(pickupBlade);

  const pickup = {
    group,
    weapon,
    bobOffset: Math.random() * Math.PI * 2,
    baseY,
    towerLoot,
  };
  pickupsGroup.add(group);
  pickups.push(pickup);
  return pickup;
}

function addProps(): void {
  const rockCount = 8;
  const rocks = new THREE.InstancedMesh(sharedGeometries.rock, stoneMaterial, rockCount);
  rocks.castShadow = true;
  rocks.receiveShadow = true;

  for (let index = 0; index < rockCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 36 + Math.random() * (ARENA_RADIUS * 0.62);
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
  const trunks = new THREE.InstancedMesh(
    sharedGeometries.treeTrunk,
    treeTrunkMaterial,
    treeCount,
  );
  const foliage = new THREE.InstancedMesh(
    sharedGeometries.treeFoliage,
    treeFoliageMaterial,
    treeCount,
  );
  trunks.castShadow = true;
  foliage.castShadow = false;

  for (let index = 0; index < treeCount; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 34 + Math.random() * (ARENA_RADIUS * 0.58);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const scale = 0.8 + Math.random() * 0.35;
    const groundY = sampleTerrainHeight(x, z);
    const yaw = Math.random() * Math.PI * 2;

    dummy.position.set(x, groundY + 0.55 * scale, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);

    dummy.position.set(x, groundY + 1.35 * scale, z);
    dummy.updateMatrix();
    foliage.setMatrixAt(index, dummy.matrix);
  }
  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  props.add(trunks, foliage);
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
  verticalVelocity = 0;
  isGrounded = true;
  invulnerable = 0;
  stormRadius = STORM_START_RADIUS;
  stormTimer = 0;
  nearestPickup = null;
  cameraShakeDecay = 0;
  clearMoveDestination();
  isAttackKeyHeld = false;
  attackChargeTime = 0;
  hudCache.health = -1;
  hudCache.chargeScale = -1;
  syncEquippedFromSelectedSlot();

  snapToGround(player);

  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2 + Math.random() * 0.35;
    const radius = 24 + Math.random() * (ARENA_RADIUS * 0.55);
    enemies.push(
      createEnemy(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.94 + Math.random() * 0.18),
    );
  }

  for (let index = 0; index < 3; index += 1) {
    const weapon = WEAPONS[1 + Math.floor(Math.random() * 4)];
    const angle = Math.random() * Math.PI * 2;
    const radius = 12 + Math.random() * (ARENA_RADIUS * 0.65);
    createPickup(weapon, Math.cos(angle) * radius, Math.sin(angle) * radius);
  }

  spawnTowerLoot();
}

function spawnTowerLoot(): void {
  for (const tower of lootTowers) {
    tower.looted = false;
    getTowerLootWorldPosition(tower, towerLootPosition);
    createPickup(tower.weapon, towerLootPosition.x, towerLootPosition.z, {
      towerLoot: true,
      worldY: towerLootPosition.y,
    });
  }
}

function markTowerLootedIfNeeded(pickup: Pickup): void {
  for (const tower of lootTowers) {
    if (tower.looted || tower.weapon !== pickup.weapon) {
      continue;
    }
    const dx = tower.root.position.x - pickup.group.position.x;
    const dz = tower.root.position.z - pickup.group.position.z;
    if (Math.hypot(dx, dz) < 6) {
      tower.looted = true;
      return;
    }
  }
}

function setState(nextState: GameState): void {
  state = nextState;
  getSession().state = nextState;

  const showStart = nextState === "start";
  const showEnd = nextState === "ended";
  const showMessage = nextState === "playing";
  const showMinimap = nextState === "playing";
  const inMatch = nextState === "playing";

  backdropScenery.visible = showStart || inMatch;
  hud.classList.toggle("hud--menu", showStart || showEnd);
  if (inMatch) {
    setShopOpen(false);
  }
  inventoryBar.classList.toggle("hidden", showEnd);
  renderer.domElement.classList.toggle("game-canvas--playing", inMatch);
  if (inMatch) {
    resetGraphicsSyncState();
  }
  gameCursor.classList.toggle("hidden", !inMatch);
  aimReticle.classList.toggle("hidden", !inMatch);
  releaseGamePointerLock();

  startPanel.classList.toggle("hidden", !showStart);
  startPanel.toggleAttribute("inert", !showStart);
  endPanel.classList.toggle("hidden", !showEnd);
  endPanel.toggleAttribute("inert", !showEnd);
  message.classList.toggle("hidden", !showMessage);
  minimapPanel.classList.toggle("hidden", !showMinimap);

  if (!inMatch) {
    setMenuCamera();
  }
}

function startMatch(): void {
  if (state === "playing") {
    return;
  }

  setShopOpen(false);
  spawnMatch();
  playerBuffs.clear();
  renderBuffHud();
  fpsMeter.reset();
  setState("playing");
  useDragAim = true;
  isCanvasAiming = false;
  updateMinimap();
  message.textContent = "Right-click move · Hold A slash · B shop · 1-5 inventory";
  renderInventoryHud();
  shardsText.textContent = String(session.shards);
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
  const scaled = amount * playerBuffs.getModifiers().damageTaken;
  playerHealth = Math.max(0, playerHealth - scaled);
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
  const reward = 28 + Math.floor(Math.random() * 14);
  session.shards += reward;
  hudCache.shards = -1;
  const mods = playerBuffs.getModifiers();
  if (mods.healOnKill > 0) {
    playerHealth = Math.min(100, playerHealth + mods.healOnKill);
    hudCache.health = -1;
  }

  if (Math.random() > 0.48) {
    const weapon = WEAPONS[1 + Math.floor(Math.random() * (WEAPONS.length - 1))];
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

  const bladeColor = new THREE.Color(WEAPONS[equippedWeaponIndex]?.color ?? 0xffffff);
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

  const mods = playerBuffs.getModifiers();
  const range = equippedWeapon.range * (charged ? CHARGED_RANGE_MULTIPLIER : 1);
  const damage =
    equippedWeapon.damage * (charged ? CHARGED_DAMAGE_MULTIPLIER : 1) * mods.damageDealt;
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
  const pickupWeapon = nearestPickup.weapon;
  const added = addWeaponToInventory(session.inventory, pickupWeapon);
  if (added) {
    const slotIndex = session.inventory.findIndex(
      (slot) => slot?.kind === "weapon" && slot.weaponIndex === getWeaponIndex(pickupWeapon),
    );
    if (slotIndex >= 0) {
      session.selectedSlot = slotIndex;
    }
    syncEquippedFromSelectedSlot();
    renderInventoryHud();
  } else {
    equipWeapon(pickupWeapon);
  }
  markTowerLootedIfNeeded(nearestPickup);
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
      moveSpeed = 5.2 * playerBuffs.getModifiers().moveSpeed;
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

  resolveTowerWallCollision(
    lootTowers,
    player.position.x,
    player.position.z,
    towerCollisionScratch,
  );
  player.position.x = towerCollisionScratch.x;
  player.position.z = towerCollisionScratch.y;

  player.rotation.y = Math.atan2(playerDirection.x, playerDirection.z);
  applyPlayerJumpPhysics(delta);
  playerBlobShadow.position.set(
    player.position.x,
    sampleTerrainHeight(player.position.x, player.position.z) + 0.04,
    player.position.z,
  );
  const shadowScale = 1 + playerVelocity.length() * 0.035;
  playerBlobShadow.scale.set(shadowScale, shadowScale, 1);
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

}

function jump(): void {
  if (state !== "playing" || !isGrounded) {
    return;
  }

  verticalVelocity = JUMP_VELOCITY;
  isGrounded = false;
  cameraShakeDecay = Math.max(cameraShakeDecay, 0.06);
}

function setMenuCamera(): void {
  camera.position.set(64, 32, 68);
  camera.lookAt(0, 7, 0);
}

function updateCamera(delta: number): void {
  if (state !== "playing") {
    setMenuCamera();
    return;
  }

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

function updateEnemies(
  delta: number,
  tuning: PerformanceTuning,
): void {
  for (const enemy of enemies) {
    enemy.cooldown = Math.max(0, enemy.cooldown - delta);
    enemy.stun = Math.max(0, enemy.stun - delta);

    const distToPlayer = enemy.group.position.distanceTo(player.position);
    if (distToPlayer > ENEMY_UPDATE_NEAR && tickFrame % tuning.enemyFarSkipInterval !== 0) {
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

    if (distToPlayer < 48 && tickFrame % tuning.enemyAnimInterval === 0) {
      enemy.walkPhase += delta * (3.8 + moveSpeed * 0.5) * tuning.enemyAnimInterval;
      const attackSwing =
        distance < 1.75 && enemy.cooldown > 0.45 ? 1 : 0;
      animateHumanoid(enemy.humanoid, moveSpeed, enemy.walkPhase, attackSwing);
    }
  }
}

function updatePickups(delta: number): void {
  let nearestDistance = Number.POSITIVE_INFINITY;
  nearestPickup = null;

  const insideTower = findTowerPlayerIsInside(
    lootTowers,
    player.position.x,
    player.position.z,
  );

  for (const pickup of pickups) {
    const distance = pickup.group.position.distanceTo(player.position);
    if (distance < 55) {
      pickup.group.rotation.y += delta * 1.1;
      if (pickup.towerLoot) {
        pickup.group.position.y =
          pickup.baseY + Math.sin(clock.elapsedTime * 2.1 + pickup.bobOffset) * 0.06;
      } else {
        const groundY = sampleTerrainHeight(pickup.group.position.x, pickup.group.position.z);
        pickup.group.position.y =
          groundY + 0.55 + Math.sin(clock.elapsedTime * 2.1 + pickup.bobOffset) * 0.1;
        pickup.baseY = pickup.group.position.y;
      }
    }
    const pickupRange = pickup.towerLoot ? 3.6 : 2.4;
    if (distance < pickupRange && distance < nearestDistance) {
      nearestDistance = distance;
      nearestPickup = pickup;
    }
  }

  if (
    insideTower &&
    !insideTower.looted &&
    (!nearestPickup || nearestPickup.weapon !== insideTower.weapon)
  ) {
    for (const pickup of pickups) {
      if (pickup.weapon === insideTower.weapon) {
        nearestPickup = pickup;
        break;
      }
    }
  }

  const nearbyTower = findNearestTower(
    lootTowers,
    player.position.x,
    player.position.z,
    14,
  );

  if (nearestPickup) {
    const towerHint = nearestPickup.towerLoot ? " · tower chest" : "";
    message.textContent = `Press E to pick up ${nearestPickup.weapon.name}${towerHint}`;
    message.classList.remove("hidden");
  } else if (insideTower && !insideTower.looted) {
    message.textContent = `Open the chest for ${insideTower.weapon.name} — Press E`;
    message.classList.remove("hidden");
  } else if (nearbyTower) {
    message.textContent = `Walk through the doorway to loot ${nearbyTower.weapon.name}`;
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
  stormRadius = Math.max(STORM_MIN_RADIUS, STORM_START_RADIUS - stormTimer * 0.16);
  stormRing.scale.setScalar(stormRadius);

  const distance = Math.hypot(player.position.x, player.position.z);
  if (distance > stormRadius) {
    const stormDamage = delta * 10 * (1 - playerBuffs.getModifiers().stormDamageReduction);
    applyPlayerDamage(stormDamage);
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
  playerBuffs.tick(delta);
  renderBuffHud();
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

  const flashing =
    invulnerable > 0 && tickFrame % 2 === 0 && Math.sin(clock.elapsedTime * 34) > 0;
  setHumanoidFlash(playerHumanoid, playerPalette, flashing);
}

function updateMinimap(): void {
  arenaMinimap.draw({
    playerX: player.position.x,
    playerZ: player.position.z,
    playerYaw: player.rotation.y,
    stormRadius,
    enemies: enemies.map((enemy) => ({
      x: enemy.group.position.x,
      z: enemy.group.position.z,
    })),
    moveTargetX: moveTarget.x,
    moveTargetZ: moveTarget.z,
    hasMoveTarget,
  });
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
  const shards = session.shards;
  if (shards !== hudCache.shards) {
    shardsText.textContent = String(shards);
    titleShopShardsText.textContent = String(shards);
    hudCache.shards = shards;
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
  const delta = Math.min(clock.getDelta(), 0.05);
  tickFrame += 1;
  let quality = cachedRenderQuality;
  if (tickFrame % 24 === 0) {
    const qualityFps =
      tickFrame < 45
        ? 72
        : getEffectiveFps(fpsMeter.renderSmoothedFps, fpsMeter.renderInstantFps);
    quality = getRenderQuality(qualityFps);
    cachedRenderQuality = quality;
    renderPixelRatio = applyAdaptivePixelRatio(
      renderer,
      quality.pixelRatioCap,
      renderPixelRatio,
    );
    postPipeline.setQuality(getPostFxQuality(qualityFps));
    syncSunShadowQuality(sunLight, quality.shadowMapSize);
  }
  const { tuning } = quality;
  const playing = state === "playing";
  if (tickFrame % 12 === 0) {
    syncEnvironmentRendering(scene, true, renderer);
    syncShadowRendering(renderer, sunLight, arenaTerrain.mesh, playing);
  }

  if (playing) {
    updateMovement(delta);
    updateWeapon(delta);
    updateEnemies(delta, tuning);
    updateStorm(delta);
    if (tickFrame % tuning.pickupFrameInterval === 0) {
      updatePickups(delta);
    }
    if (tickFrame % tuning.minimapFrameInterval === 0) {
      updateMinimap();
    }
    if (attackTime > 0) {
      updateSlashEffects(delta);
    }
    updateCamera(delta);
    if (tickFrame % tuning.hudFrameInterval === 0) {
      updateHud();
    }
    if (quality.shadowsEnabled && tickFrame % tuning.shadowFrameInterval === 0) {
      renderer.shadowMap.needsUpdate = true;
    }
    postPipeline.render();
    fpsMeter.endRenderFrame();
    return;
  }

  updateCamera(delta);
  if (quality.shadowsEnabled && tickFrame % tuning.shadowFrameInterval === 0) {
    renderer.shadowMap.needsUpdate = true;
  }
  postPipeline.render();
  fpsMeter.endRenderFrame();
}

function resize(): void {
  const { width, height } = getViewportSize();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  postPipeline.setSize(width, height);
}

window.addEventListener("resize", resize);
if (typeof ResizeObserver !== "undefined") {
  const viewportObserver = new ResizeObserver(() => resize());
  viewportObserver.observe(app);
}
window.addEventListener("keydown", (event) => {
  if (event.repeat) {
    return;
  }
  if (event.code === "Space" && !shopOpen) {
    event.preventDefault();
    jump();
  }
  if (event.code === "KeyA" && !shopOpen) {
    event.preventDefault();
    beginAttackCharge();
  }
  if (event.code === "KeyE") {
    pickUpNearest();
  }
  if (event.code === "KeyR" && state !== "playing") {
    startMatch();
  }
  if (event.code === "KeyB") {
    toggleShop();
  }
  const slotKey = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].indexOf(event.code);
  if (slotKey >= 0) {
    useInventorySlot(slotKey);
  }
});

for (const button of inventorySlotButtons) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const slot = Number(button.dataset.invSlot);
    useInventorySlot(slot);
  });
}

shopPanel.querySelectorAll("[data-shop-close]").forEach((element) => {
  element.addEventListener("click", () => setShopOpen(false));
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
  if (state !== "playing" || shopOpen) {
    return;
  }

  if (event.button === 0) {
    isCameraRotating = true;
    isCanvasAiming = true;
    useDragAim = true;
    cameraRotateStartX = event.clientX;
    cameraRotateStartY = event.clientY;
    renderer.domElement.classList.add("game-canvas--aiming");
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
    renderer.domElement.classList.remove("game-canvas--aiming");
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

renderer.domElement.addEventListener("mouseleave", () => {
  gameCursor.classList.add("hidden");
});

function applyMouseLook(movementX: number, movementY: number): void {
  cameraYaw -= movementX * 0.0022;
  cameraPitch -= movementY * 0.0014;
}

function isPointerLocked(): boolean {
  return document.pointerLockElement === renderer.domElement;
}

function releaseGamePointerLock(): void {
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
}

function updateGameCursor(clientX: number, clientY: number): void {
  gameCursor.style.left = `${clientX}px`;
  gameCursor.style.top = `${clientY}px`;
}

function syncGameCursorVisibility(clientX: number, clientY: number): void {
  if (state !== "playing") {
    gameCursor.classList.add("hidden");
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const inside =
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom;
  const locked = isPointerLocked();
  gameCursor.classList.toggle("hidden", !inside);
  gameCursor.classList.toggle("game-cursor--locked", locked);
  if (inside) {
    updateGameCursor(clientX, clientY);
  }
}

document.addEventListener("pointerlockchange", () => {
  if (state === "playing" && isPointerLocked()) {
    releaseGamePointerLock();
  }
});

window.addEventListener("mousemove", (event) => {
  syncGameCursorVisibility(event.clientX, event.clientY);
  if (isPointerLocked()) {
    applyMouseLook(event.movementX, event.movementY);
    return;
  }
  if (!isCameraRotating) {
    return;
  }
  applyMouseLook(event.movementX, event.movementY);
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

window.addEventListener("mouseup", () => {
  isCanvasAiming = false;
  renderer.domElement.classList.remove("game-canvas--aiming");
});

function handleStartClick(event: MouseEvent): void {
  event.stopPropagation();
  event.preventDefault();
  startMatch();
}

startButton.addEventListener("click", handleStartClick);
restartButton.addEventListener("click", handleStartClick);

titleShopButton.addEventListener("click", (event) => {
  event.stopPropagation();
  event.preventDefault();
  setShopOpen(true);
});

syncShopShardLabels();

function bootGame(): void {
  const session = getSession();

  if (import.meta.hot || isEmbeddedPreview()) {
    session.state = "start";
  }

  if (!session.initialized) {
    session.initialized = true;
    session.state = "start";
    addProps();
    snapToGround(player);
    syncEquippedFromSelectedSlot();
    setState("start");
    return;
  }

  if (!isEmbeddedPreview() && session.state === "playing" && enemies.length > 0) {
    setState("playing");
    return;
  }

  session.state = "start";
  setState("start");
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null);
  });
}

try {
  resize();
  bootGame();
  updateCamera(1);
  function initRealisticGraphics(): void {
    try {
      syncEnvironmentRendering(scene, true, renderer);
      syncShadowRendering(renderer, sunLight, arenaTerrain.mesh, true);
    } catch (error) {
      console.warn("Realistic lighting setup deferred:", error);
    }
  }

  postPipeline.setQuality(getPostFxQuality(72));
  postPipeline.render();
  fpsMeter.endRenderFrame();
  renderer.setAnimationLoop(tick);
  requestAnimationFrame(initRealisticGraphics);
  bootComplete = true;
} catch (error) {
  console.error(error);
  showBootError(error);
}
