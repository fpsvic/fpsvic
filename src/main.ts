import "./styles.css";

type Mode = "" | "normal" | "fantasy";

type Guy = {
  id: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  level: number;
  hp: number;
  maxHp: number;
  radius: number;
  speed: number;
  lastShot: number;
  isBot: boolean;
  name: string;
};

type Zombie = {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;
  speed: number;
  isBoss: boolean;
};

type Bullet = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  ownerId: string;
  isBot: boolean;
  life: number;
};

type Food = {
  x: number;
  y: number;
};

type FloatText = {
  text: string;
  x: number;
  y: number;
  color: string;
  life: number;
  world: boolean;
};

type LeaderboardScore = {
  name: string;
  wave: number;
  date: number;
};

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
};

const startScreen = $("startScreen");
const playBtn = $("playBtn") as HTMLButtonElement;
const usernameInput = $("usernameInput") as HTMLInputElement;
const nameError = $("nameError");
const leaderboardBtn = $("leaderboardBtn") as HTMLButtonElement;
const leaderboardScreen = $("leaderboardScreen");
const closeLeaderboardBtn = $("closeLeaderboardBtn") as HTMLButtonElement;
const leaderboardBody = $("leaderboardBody") as HTMLTableSectionElement;
const emptyLeaderboardMsg = $("emptyLeaderboardMsg");
const rulesScreen = $("rulesScreen");
const rulesBackBtn = $("rulesBackBtn") as HTMLButtonElement;
const normalModeBtn = $("normalModeBtn") as HTMLButtonElement;
const fantasyShopBtn = $("fantasyShopBtn") as HTMLButtonElement;
const tutorialBtn = $("tutorialBtn") as HTMLButtonElement;
const tutorialScreen = $("tutorialScreen");
const closeTutorialBtn = $("closeTutorialBtn") as HTMLButtonElement;
const tutorialScreenText = $("tutorialScreenText");
const tutorialDots = $("tutorialDots");
const tutorialCanvas = $("tutorialCanvas") as HTMLCanvasElement;
const fantasyShopScreen = $("fantasyShopScreen");
const closeFantasyShopBtn = $("closeFantasyShopBtn") as HTMLButtonElement;
const fantasyShopGrid = $("fantasyShopGrid");
const fantasyShopMoney = $("fantasyShopMoney");
const startFightBtn = $("startFightBtn") as HTMLButtonElement;
const matchmakingScreen = $("matchmakingScreen");
const cancelMatchBtn = $("cancelMatchBtn") as HTMLButtonElement;
const countdownTimer = $("countdownTimer");
const playerCountText = $("playerCountText");
const gameUI = $("gameUI");
const normalUI = $("normalUI");
const fantasyStatsUI = $("fantasyStatsUI");
const homeBtn = $("homeBtn") as HTMLButtonElement;
const buyLvl1Btn = $("buyLvl1Btn") as HTMLButtonElement;
const buyLvl2Btn = $("buyLvl2Btn") as HTMLButtonElement;
const buyLvl3Btn = $("buyLvl3Btn") as HTMLButtonElement;
const healthDisplay = $("healthDisplay");
const coinDisplay = $("coinDisplay");
const waveNumDisplay = $("waveNumDisplay");
const aliveDisplay = $("aliveDisplay");
const bankDisplay = $("bankDisplay");
const fantasyMinimap = $("fantasyMinimap");
const minimapCanvas = $("minimapCanvas") as HTMLCanvasElement;
const leaveFantasyBtn = $("leaveFantasyBtn") as HTMLButtonElement;
const quitConfirmScreen = $("quitConfirmScreen");
const confirmQuitBtn = $("confirmQuitBtn") as HTMLButtonElement;
const cancelQuitBtn = $("cancelQuitBtn") as HTMLButtonElement;
const gameOverScreen = $("gameOverScreen");
const gameOverTitle = $("gameOverTitle");
const gameOverStats = $("gameOverStats");
const restartBtn = $("restartBtn") as HTMLButtonElement;
const enterShelterBtn = $("enterShelterBtn") as HTMLButtonElement;
const toastMessage = $("toastMessage");
const musicBtn = $("musicBtn") as HTMLButtonElement;
const gameCanvas = $("gameCanvas") as HTMLCanvasElement;

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(`Unable to initialize canvas context for #${canvas.id}.`);
  }
  return context;
}

const ctx = getCanvasContext(gameCanvas);
const tutorialContext = getCanvasContext(tutorialCanvas);
const minimapContext = getCanvasContext(minimapCanvas);

const arenaSize = 4000;
const shelter = { x: 2000, y: 2000, radius: 300, cost: 60000 };
const dungeon = { x: 50, y: 1000, w: 600, h: 800 };
const buyCosts = { 1: 25, 2: 50, 3: 100 };
const storageKeys = {
  username: "mergeGuys_username",
  money: "mergeGuys_fantasyMoney",
  scores: "mergeGuys_scores",
};

let mode: Mode = "";
let username = "";
let isPlaying = false;
let isPaused = false;
let matchmakingId = 0;
let tutorialId = 0;
let tutorialTimer = 0;
let tutorialStep = 0;
let lastTime = performance.now();
let health = 100;
let coins = 50;
let wave = 1;
let spawnTimer = 0;
let fantasyMoneyValue = Number(localStorage.getItem(storageKeys.money) ?? 0) || 0;
let equippedFantasyLevel = 1;
let camX = 0;
let camY = 0;
let player: Guy | null = null;
let dragon: Guy | null = null;
let draggingGuy: Guy | null = null;
let dragRect: { x: number; y: number; w: number; h: number } | null = null;
let inShelter = false;
let shelterStartedAt = 0;
let musicEnabled = true;
let audioContext: AudioContext | null = null;
let musicTimer = 0;

const keys = new Set<string>();
const mouse = { x: 0, y: 0, startX: 0, startY: 0, down: false };
const guys: Guy[] = [];
const zombies: Zombie[] = [];
const normalBullets: Bullet[] = [];
const fantasyEntities: Guy[] = [];
const fantasyBullets: Bullet[] = [];
const fantasyFood: Food[] = [];
const floatTexts: FloatText[] = [];

function resizeCanvas(): void {
  gameCanvas.width = window.innerWidth;
  gameCanvas.height = window.innerHeight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function hide(element: HTMLElement): void {
  element.classList.add("hidden");
}

function show(element: HTMLElement): void {
  element.classList.remove("hidden");
}

function randomId(): string {
  return Math.random().toString(36).slice(2);
}

function makeGuy(x: number, y: number, level: number, isBot = false, id = randomId()): Guy {
  const capped = clamp(Math.round(level), 1, 30);
  return {
    id,
    x,
    y,
    tx: x,
    ty: y,
    level: capped,
    hp: 50 + capped * 30,
    maxHp: 50 + capped * 30,
    radius: Math.min(18 + capped * 2, 80),
    speed: 4 + capped * 0.15 + Math.random(),
    lastShot: 0,
    isBot,
    name: isBot ? `(bot) Slayer${Math.floor(Math.random() * 99)}` : username,
  };
}

function makeZombie(x: number, y: number, isBoss: boolean): Zombie {
  const hp = isBoss ? 180 * wave : 20 + wave * 7;
  return {
    x,
    y,
    hp,
    maxHp: hp,
    radius: isBoss ? 36 : 18,
    speed: isBoss ? 0.9 : 0.9 + wave * 0.04,
    isBoss,
  };
}

function updateGuyLevel(guy: Guy, level: number): void {
  guy.level = clamp(Math.round(level), 1, 30);
  guy.radius = Math.min(18 + guy.level * 2, 80);
  guy.maxHp = 50 + guy.level * 30;
  guy.hp = Math.min(guy.maxHp, guy.hp + guy.level * 15);
}

function setMoney(value: number): void {
  fantasyMoneyValue = Math.max(0, Math.round(value));
  localStorage.setItem(storageKeys.money, String(fantasyMoneyValue));
  fantasyShopMoney.textContent = fantasyMoneyValue.toLocaleString();
  bankDisplay.textContent = fantasyMoneyValue.toLocaleString();
}

function updateUI(): void {
  healthDisplay.textContent = String(Math.max(0, Math.ceil(health)));
  coinDisplay.textContent = String(coins);
  waveNumDisplay.textContent = String(wave);
  if (mode === "fantasy") {
    const enemiesLeft = fantasyEntities.filter((entity) => entity.id !== "player" && entity.id !== "dragon").length;
    aliveDisplay.textContent = String(enemiesLeft + (player && player.hp > 0 ? 1 : 0));
  }
  setMoney(fantasyMoneyValue);
}

function showToast(text: string, color = "#10b981"): void {
  toastMessage.textContent = text;
  toastMessage.style.background = color;
  show(toastMessage);
  window.setTimeout(() => hide(toastMessage), 2200);
}

function addFloatText(text: string, x: number, y: number, color: string, world = false): void {
  floatTexts.push({ text, x, y, color, life: 70, world });
  if (floatTexts.length > 40) {
    floatTexts.shift();
  }
}

function readScores(): LeaderboardScore[] {
  try {
    return JSON.parse(localStorage.getItem(storageKeys.scores) ?? "[]") as LeaderboardScore[];
  } catch {
    return [];
  }
}

function saveScore(): void {
  const name = username.trim();
  if (!name || name.toLowerCase().includes("bot")) {
    return;
  }
  const scores = readScores().filter((score) => Date.now() - score.date < 24 * 60 * 60 * 1000);
  scores.push({ name, wave, date: Date.now() });
  localStorage.setItem(storageKeys.scores, JSON.stringify(scores));
}

function renderLeaderboard(): void {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const scores = readScores()
    .filter((score) => score.date > dayAgo)
    .sort((a, b) => b.wave - a.wave)
    .slice(0, 10);
  leaderboardBody.innerHTML = "";
  emptyLeaderboardMsg.classList.toggle("hidden", scores.length > 0);
  for (const score of scores) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const waveCell = document.createElement("td");
    nameCell.textContent = score.name;
    waveCell.textContent = String(score.wave);
    row.append(nameCell, waveCell);
    leaderboardBody.append(row);
  }
}

function createAudioContext(): AudioContext | null {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }
  return audioContext;
}

function tone(freq: number, duration = 0.12, volume = 0.04): void {
  if (!musicEnabled) {
    return;
  }
  const audio = createAudioContext();
  if (!audio) {
    return;
  }
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, audio.currentTime);
  gain.gain.linearRampToValueAtTime(volume, audio.currentTime + 0.01);
  gain.gain.linearRampToValueAtTime(0.0001, audio.currentTime + duration);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duration + 0.02);
}

function startMusic(): void {
  if (!musicEnabled || musicTimer) {
    return;
  }
  const notes = [196, 247, 294, 247, 220, 262, 330, 262];
  let index = 0;
  musicTimer = window.setInterval(() => {
    tone(notes[index % notes.length], 0.08, 0.025);
    index += 1;
  }, 260);
}

function stopMusic(): void {
  window.clearInterval(musicTimer);
  musicTimer = 0;
  void audioContext?.suspend();
}

function shoot(guy: Guy, tx: number, ty: number, now: number, bullets: Bullet[]): void {
  const fireRate = guy.id === "dragon" ? 1050 : Math.max(90, 780 - guy.level * 22);
  if (now - guy.lastShot < fireRate) {
    return;
  }
  guy.lastShot = now;
  const count = guy.id === "dragon" ? 3 : guy.level >= 30 ? 8 : guy.level >= 20 ? 4 : guy.level >= 5 ? 2 : 1;
  const base = Math.atan2(ty - guy.y, tx - guy.x);
  const spread = count === 1 ? 0 : 0.42;
  for (let index = 0; index < count; index += 1) {
    const angle = base - spread / 2 + (count === 1 ? 0 : (spread * index) / (count - 1));
    bullets.push({
      x: guy.x,
      y: guy.y,
      vx: Math.cos(angle) * 12,
      vy: Math.sin(angle) * 12,
      damage: guy.id === "dragon" ? 80 : 10 + guy.level * 4,
      ownerId: guy.id,
      isBot: guy.isBot,
      life: guy.level >= 30 ? 420 : 160 + guy.level * 8,
    });
  }
  tone(guy.id === "dragon" ? 120 : 180 + guy.level * 8, 0.05, 0.025);
}

function drawGuy(guy: Guy): void {
  const sx = mode === "fantasy" ? guy.x - camX : guy.x;
  const sy = mode === "fantasy" ? guy.y - camY : guy.y;
  if (sx < -120 || sx > gameCanvas.width + 120 || sy < -120 || sy > gameCanvas.height + 120) {
    return;
  }
  ctx.save();
  ctx.translate(sx, sy);
  if (draggingGuy === guy) {
    ctx.shadowColor = "#34d399";
    ctx.shadowBlur = 18;
  }
  ctx.fillStyle = guy.id === "dragon" ? "#b91c1c" : guy.isBot ? "#ef4444" : "#34d399";
  ctx.beginPath();
  ctx.arc(0, 0, guy.id === "dragon" ? 80 : guy.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#020617";
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(guy.id === "dragon" ? "BOSS" : `L${guy.level}`, 0, 0);
  if (mode === "fantasy") {
    const barWidth = (guy.id === "dragon" ? 160 : guy.radius * 2) * clamp(guy.hp / guy.maxHp, 0, 1);
    ctx.fillStyle = "#020617";
    ctx.fillRect(-(guy.id === "dragon" ? 80 : guy.radius), -guy.radius - 18, guy.id === "dragon" ? 160 : guy.radius * 2, 7);
    ctx.fillStyle = "#10b981";
    ctx.fillRect(-(guy.id === "dragon" ? 80 : guy.radius), -guy.radius - 18, barWidth, 7);
    ctx.fillStyle = "#fff";
    ctx.font = "12px Arial";
    ctx.fillText(guy.name, 0, -guy.radius - 30);
  }
  ctx.restore();
}

function drawZombie(zombie: Zombie): void {
  ctx.save();
  ctx.translate(zombie.x, zombie.y);
  ctx.fillStyle = zombie.isBoss ? "#b91c1c" : "#166534";
  ctx.beginPath();
  ctx.arc(0, 0, zombie.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#020617";
  ctx.stroke();
  ctx.fillStyle = "#020617";
  ctx.fillRect(-zombie.radius, -zombie.radius - 12, zombie.radius * 2, 7);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(-zombie.radius, -zombie.radius - 12, zombie.radius * 2 * clamp(zombie.hp / zombie.maxHp, 0, 1), 7);
  if (zombie.isBoss) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Arial";
    ctx.textAlign = "center";
    ctx.fillText("BOSS", 0, -zombie.radius - 20);
  }
  ctx.restore();
}

function drawGrid(): void {
  ctx.fillStyle = "#022c22";
  ctx.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  ctx.strokeStyle = "rgb(5 150 105 / 22%)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -(camX % 50); x < gameCanvas.width; x += 50) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, gameCanvas.height);
  }
  for (let y = -(camY % 50); y < gameCanvas.height; y += 50) {
    ctx.moveTo(0, y);
    ctx.lineTo(gameCanvas.width, y);
  }
  ctx.stroke();
}

function drawNormal(): void {
  ctx.fillStyle = "#4b5563";
  ctx.fillRect(0, 0, 60, gameCanvas.height);
  ctx.fillStyle = "#9ca3af";
  ctx.fillRect(48, 0, 12, gameCanvas.height);
  ctx.save();
  ctx.translate(25, gameCanvas.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px Arial";
  ctx.textAlign = "center";
  ctx.fillText("YOUR BASE", 0, 0);
  ctx.restore();
  normalBullets.forEach((bullet) => {
    ctx.fillStyle = "#fef08a";
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  zombies.forEach(drawZombie);
  guys.forEach(drawGuy);
  if (dragRect) {
    ctx.fillStyle = "rgb(52 211 153 / 22%)";
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 2;
    ctx.fillRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    ctx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
  }
}

function drawFantasy(): void {
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 10;
  ctx.strokeRect(-camX, -camY, arenaSize, arenaSize);
  ctx.fillStyle = "rgb(16 185 129 / 16%)";
  ctx.beginPath();
  ctx.arc(shelter.x - camX, shelter.y - camY, shelter.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "rgb(139 92 246 / 16%)";
  ctx.fillRect(dungeon.x - camX, dungeon.y - camY, dungeon.w, dungeon.h);
  ctx.strokeStyle = "#8b5cf6";
  ctx.strokeRect(dungeon.x - camX, dungeon.y - camY, dungeon.w, dungeon.h);
  for (const food of fantasyFood) {
    ctx.fillStyle = "#34d399";
    ctx.beginPath();
    ctx.arc(food.x - camX, food.y - camY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  fantasyBullets.forEach((bullet) => {
    ctx.fillStyle = bullet.isBot ? "#f87171" : "#fef08a";
    ctx.beginPath();
    ctx.arc(bullet.x - camX, bullet.y - camY, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  fantasyEntities.forEach(drawGuy);
}

function drawFloatTexts(): void {
  for (const text of floatTexts) {
    ctx.save();
    ctx.globalAlpha = clamp(text.life / 70, 0, 1);
    ctx.fillStyle = text.color;
    ctx.font = "bold 20px Arial";
    ctx.textAlign = "center";
    ctx.fillText(text.text, text.world ? text.x - camX : text.x, text.world ? text.y - camY : text.y);
    ctx.restore();
  }
}

function drawMinimap(): void {
  minimapContext.clearRect(0, 0, 192, 192);
  const scale = 192 / arenaSize;
  minimapContext.fillStyle = "rgb(16 185 129 / 32%)";
  minimapContext.beginPath();
  minimapContext.arc(shelter.x * scale, shelter.y * scale, shelter.radius * scale, 0, Math.PI * 2);
  minimapContext.fill();
  minimapContext.fillStyle = "rgb(139 92 246 / 35%)";
  minimapContext.fillRect(dungeon.x * scale, dungeon.y * scale, dungeon.w * scale, dungeon.h * scale);
  for (const entity of fantasyEntities) {
    minimapContext.fillStyle = entity.id === "player" ? "#34d399" : entity.id === "dragon" ? "#a78bfa" : "#ef4444";
    minimapContext.fillRect(entity.x * scale - 2, entity.y * scale - 2, entity.id === "dragon" ? 7 : 4, entity.id === "dragon" ? 7 : 4);
  }
  minimapContext.strokeStyle = "rgb(255 255 255 / 45%)";
  minimapContext.strokeRect(camX * scale, camY * scale, gameCanvas.width * scale, gameCanvas.height * scale);
}

function draw(): void {
  drawGrid();
  if (mode === "normal") {
    drawNormal();
  } else if (mode === "fantasy") {
    drawFantasy();
    drawMinimap();
  }
  drawFloatTexts();
}

function updateFloatTexts(): void {
  for (let index = floatTexts.length - 1; index >= 0; index -= 1) {
    const text = floatTexts[index];
    text.y -= 0.45;
    text.life -= 1;
    if (text.life <= 0) {
      floatTexts.splice(index, 1);
    }
  }
}

function getBuySpawnPoint(): { x: number; y: number } {
  const startX = 132;
  const startY = gameCanvas.height / 2;
  const spacing = 48;
  for (let slot = 0; slot < 90; slot += 1) {
    const col = Math.floor(slot / 7);
    const row = slot % 7;
    const x = startX + col * spacing;
    const y = startY + (row - 3) * spacing;
    const occupied = guys.some((guy) => dist(guy.x, guy.y, x, y) < 12);
    if (!occupied) {
      return { x, y };
    }
  }
  return { x: startX, y: startY };
}

function buyNormalGuy(level: 1 | 2 | 3): void {
  const cost = buyCosts[level];
  if (coins < cost) {
    showToast("Not enough coins!", "#ef4444");
    return;
  }
  coins -= cost;
  const spawn = getBuySpawnPoint();
  guys.push(makeGuy(spawn.x, spawn.y, level, false, "player"));
  tone(520, 0.08, 0.05);
  updateUI();
}

function updateNormal(now: number, delta: number): void {
  spawnTimer += delta;
  const interval = Math.max(0.45, 1.45 - wave * 0.04);
  if (spawnTimer > interval) {
    spawnTimer = 0;
    const isBoss = wave % 5 === 0 && Math.random() < 0.22;
    zombies.push(makeZombie(gameCanvas.width + 50, 90 + Math.random() * Math.max(120, gameCanvas.height - 180), isBoss));
  }
  if (zombies.length < Math.min(3 + wave, 16) && Math.random() < 0.006 + wave * 0.0005) {
    zombies.push(makeZombie(gameCanvas.width + 50, 80 + Math.random() * Math.max(140, gameCanvas.height - 160), false));
  }
  if (now > 15000 + wave * 11500 && zombies.length < 4) {
    wave += 1;
    coins += 15 + wave * 2;
    addFloatText(`Wave ${wave}`, gameCanvas.width / 2, 130, "#86efac");
  }
  for (const zombie of zombies) {
    zombie.x -= zombie.speed * (delta * 60);
    if (zombie.x < 80) {
      health -= zombie.isBoss ? 15 : 5;
      zombie.x += 40;
      tone(110, 0.06, 0.04);
      if (health <= 0) {
        triggerGameOver(false);
      }
    }
  }
  for (const guy of guys) {
    if (!zombies.length) {
      continue;
    }
    const target = zombies.reduce((best, zombie) =>
      dist(guy.x, guy.y, zombie.x, zombie.y) < dist(guy.x, guy.y, best.x, best.y) ? zombie : best,
    );
    shoot(guy, target.x, target.y, now, normalBullets);
  }
  for (let index = normalBullets.length - 1; index >= 0; index -= 1) {
    const bullet = normalBullets[index];
    bullet.x += bullet.vx * (delta * 60);
    bullet.y += bullet.vy * (delta * 60);
    bullet.life -= 1;
    let hit = false;
    for (let zIndex = zombies.length - 1; zIndex >= 0; zIndex -= 1) {
      const zombie = zombies[zIndex];
      if (dist(bullet.x, bullet.y, zombie.x, zombie.y) < zombie.radius) {
        zombie.hp -= bullet.damage;
        hit = true;
        if (zombie.hp <= 0) {
          coins += zombie.isBoss ? 50 : 5;
          zombies.splice(zIndex, 1);
          addFloatText(zombie.isBoss ? "+50" : "+5", zombie.x, zombie.y, "#fef08a");
        }
        break;
      }
    }
    if (hit || bullet.life <= 0 || bullet.x > gameCanvas.width + 120) {
      normalBullets.splice(index, 1);
    }
  }
}

function isInDungeon(x: number, y: number): boolean {
  return x > dungeon.x && x < dungeon.x + dungeon.w && y > dungeon.y && y < dungeon.y + dungeon.h;
}

function updateFantasy(now: number, delta: number): void {
  if (!player) {
    return;
  }
  if (!inShelter) {
    let nx = player.x;
    let ny = player.y;
    const speed = player.speed * delta * 60;
    if (keys.has("w") || keys.has("arrowup")) ny -= speed;
    if (keys.has("s") || keys.has("arrowdown")) ny += speed;
    if (keys.has("a") || keys.has("arrowleft")) nx -= speed;
    if (keys.has("d") || keys.has("arrowright")) nx += speed;
    nx = clamp(nx, 50, arenaSize - 50);
    ny = clamp(ny, 50, arenaSize - 50);
    if (dist(nx, ny, shelter.x, shelter.y) > shelter.radius + 20) {
      player.x = nx;
      player.y = ny;
    }
  }
  enterShelterBtn.classList.toggle(
    "hidden",
    inShelter || dist(player.x, player.y, shelter.x, shelter.y) > shelter.radius + 100,
  );
  if ((mouse.down || keys.has("z")) && !inShelter) {
    shoot(player, mouse.x + camX, mouse.y + camY, now, fantasyBullets);
  }
  camX = clamp(player.x - gameCanvas.width / 2, 0, arenaSize - gameCanvas.width);
  camY = clamp(player.y - gameCanvas.height / 2, 0, arenaSize - gameCanvas.height);
  if (inShelter && performance.now() - shelterStartedAt > 60000) {
    inShelter = false;
    player.x = shelter.x + shelter.radius + 80;
    showToast("Shelter time expired.", "#ef4444");
  }
  if (Math.random() < 0.012 && fantasyFood.length < 18) {
    let x = 0;
    let y = 0;
    do {
      x = 80 + Math.random() * (arenaSize - 160);
      y = 80 + Math.random() * (arenaSize - 160);
    } while (dist(x, y, shelter.x, shelter.y) < shelter.radius + 40);
    fantasyFood.push({ x, y });
  }
  for (let index = fantasyFood.length - 1; index >= 0; index -= 1) {
    const food = fantasyFood[index];
    for (const entity of fantasyEntities) {
      if (entity.id !== "dragon" && entity.hp < entity.maxHp && dist(entity.x, entity.y, food.x, food.y) < entity.radius + 16) {
        entity.hp = Math.min(entity.maxHp, entity.hp + 25);
        addFloatText("+25 HP", entity.x, entity.y - 30, "#34d399", true);
        fantasyFood.splice(index, 1);
        break;
      }
    }
  }
  if (dragon) {
    const target = fantasyEntities
      .filter((entity) => entity.id !== "dragon" && isInDungeon(entity.x, entity.y))
      .sort((a, b) => dist(dragon!.x, dragon!.y, a.x, a.y) - dist(dragon!.x, dragon!.y, b.x, b.y))[0];
    if (target) {
      shoot(dragon, target.x, target.y, now, fantasyBullets);
    }
  }
  for (const bot of fantasyEntities) {
    if (!bot.isBot || bot.id === "dragon") {
      continue;
    }
    const enemies = fantasyEntities.filter((entity) => entity !== bot && entity.id !== "dragon");
    const target = enemies.sort((a, b) => dist(bot.x, bot.y, a.x, a.y) - dist(bot.x, bot.y, b.x, b.y))[0];
    if (!target) {
      continue;
    }
    const distance = dist(bot.x, bot.y, target.x, target.y);
    const angle = Math.atan2(target.y - bot.y, target.x - bot.x);
    if (distance > 280) {
      bot.x += Math.cos(angle) * bot.speed * delta * 35;
      bot.y += Math.sin(angle) * bot.speed * delta * 35;
    } else if (distance < 160) {
      bot.x -= Math.cos(angle) * bot.speed * delta * 28;
      bot.y -= Math.sin(angle) * bot.speed * delta * 28;
    }
    bot.x = clamp(bot.x, 50, arenaSize - 50);
    bot.y = clamp(bot.y, 50, arenaSize - 50);
    if (dist(bot.x, bot.y, shelter.x, shelter.y) < shelter.radius + 30) {
      bot.x += Math.cos(angle) * 80;
      bot.y += Math.sin(angle) * 80;
    }
    shoot(bot, target.x, target.y, now, fantasyBullets);
  }
  for (let index = fantasyBullets.length - 1; index >= 0; index -= 1) {
    const bullet = fantasyBullets[index];
    bullet.x += bullet.vx * delta * 60;
    bullet.y += bullet.vy * delta * 60;
    bullet.life -= 1;
    if (
      bullet.x < 0 ||
      bullet.y < 0 ||
      bullet.x > arenaSize ||
      bullet.y > arenaSize ||
      dist(bullet.x, bullet.y, shelter.x, shelter.y) < shelter.radius
    ) {
      fantasyBullets.splice(index, 1);
      continue;
    }
    let hit = false;
    for (let entityIndex = fantasyEntities.length - 1; entityIndex >= 0; entityIndex -= 1) {
      const entity = fantasyEntities[entityIndex];
      if (entity.id === bullet.ownerId || dist(bullet.x, bullet.y, entity.x, entity.y) > entity.radius) {
        continue;
      }
      entity.hp -= bullet.damage;
      hit = true;
      if (entity.hp <= 0) {
        if (entity.id === "player") {
          triggerGameOver(false);
        } else {
          if (bullet.ownerId === "player") {
            const reward = entity.id === "dragon" ? 100000 : 5000;
            setMoney(fantasyMoneyValue + reward);
            addFloatText(`+${reward.toLocaleString()}`, entity.x, entity.y, "#fef08a", true);
          }
          fantasyEntities.splice(entityIndex, 1);
          if (entity.id === "dragon") {
            dragon = null;
          }
        }
      }
      break;
    }
    if (hit || bullet.life <= 0) {
      fantasyBullets.splice(index, 1);
    }
  }
  const enemiesLeft = fantasyEntities.filter((entity) => entity.id !== "player" && entity.id !== "dragon").length;
  if (enemiesLeft === 0 && player.hp > 0) {
    triggerGameOver(true);
  }
}

function gameLoop(now: number): void {
  const delta = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;
  if (isPlaying && !isPaused) {
    if (mode === "normal") {
      updateNormal(now, delta);
    } else if (mode === "fantasy") {
      updateFantasy(now, delta);
    }
    updateFloatTexts();
    updateUI();
  }
  draw();
  requestAnimationFrame(gameLoop);
}

function resetCollections(): void {
  guys.length = 0;
  zombies.length = 0;
  normalBullets.length = 0;
  fantasyEntities.length = 0;
  fantasyBullets.length = 0;
  fantasyFood.length = 0;
  floatTexts.length = 0;
}

function startNormal(): void {
  resetCollections();
  mode = "normal";
  isPlaying = true;
  isPaused = false;
  health = 100;
  coins = 50;
  wave = 1;
  spawnTimer = 0;
  camX = 0;
  camY = 0;
  const first = getBuySpawnPoint();
  guys.push(makeGuy(first.x, first.y, 1, false, "player"));
  hide(rulesScreen);
  hide(startScreen);
  show(gameUI);
  show(normalUI);
  hide(fantasyStatsUI);
  hide(fantasyMinimap);
  hide(leaveFantasyBtn);
  updateUI();
}

function launchFantasy(): void {
  resetCollections();
  mode = "fantasy";
  isPlaying = true;
  isPaused = false;
  inShelter = false;
  hide(matchmakingScreen);
  hide(fantasyShopScreen);
  show(gameUI);
  hide(normalUI);
  show(fantasyStatsUI);
  show(fantasyMinimap);
  show(leaveFantasyBtn);
  player = makeGuy(shelter.x, shelter.y - shelter.radius - 100, equippedFantasyLevel, false, "player");
  fantasyEntities.push(player);
  dragon = makeGuy(dungeon.x + dungeon.w / 2, dungeon.y + dungeon.h / 2, 30, true, "dragon");
  dragon.hp = 15000;
  dragon.maxHp = 15000;
  dragon.speed = 0;
  dragon.name = "Dragon";
  fantasyEntities.push(dragon);
  for (let index = 0; index < 9; index += 1) {
    let x = 0;
    let y = 0;
    do {
      x = 120 + Math.random() * (arenaSize - 240);
      y = 120 + Math.random() * (arenaSize - 240);
    } while (dist(x, y, shelter.x, shelter.y) < shelter.radius + 80);
    fantasyEntities.push(makeGuy(x, y, clamp(equippedFantasyLevel + Math.floor(Math.random() * 7) - 3, 1, 30), true));
  }
  updateUI();
}

function resetToMenu(): void {
  isPlaying = false;
  isPaused = false;
  mode = "";
  player = null;
  dragon = null;
  draggingGuy = null;
  dragRect = null;
  clearInterval(matchmakingId);
  resetCollections();
  hide(gameUI);
  hide(gameOverScreen);
  hide(quitConfirmScreen);
  hide(matchmakingScreen);
  hide(fantasyShopScreen);
  hide(enterShelterBtn);
  show(startScreen);
}

function triggerGameOver(won: boolean): void {
  if (!isPlaying) {
    return;
  }
  isPlaying = false;
  hide(gameUI);
  hide(enterShelterBtn);
  show(gameOverScreen);
  if (mode === "normal") {
    gameOverTitle.textContent = "BASE DESTROYED";
    gameOverStats.textContent = `You survived to Wave ${wave}!`;
    saveScore();
  } else if (won) {
    gameOverTitle.textContent = "VICTORY ROYALE!";
    gameOverStats.textContent = "+20,000 Money Added to Bank!";
    setMoney(fantasyMoneyValue + 20000);
  } else {
    gameOverTitle.textContent = "ELIMINATED";
    gameOverStats.textContent = "You were defeated in the arena.";
  }
}

function renderFantasyShop(): void {
  fantasyShopGrid.innerHTML = "";
  for (let level = 1; level <= 30; level += 1) {
    const cost = level === 1 ? 0 : level * 2000;
    const button = document.createElement("button");
    button.className = `shop-item ${equippedFantasyLevel === level ? "equipped" : ""}`;
    button.innerHTML = `<strong>Level ${level}</strong><span>${cost === 0 ? "FREE" : `$${cost.toLocaleString()}`}</span>`;
    button.addEventListener("click", () => {
      if (equippedFantasyLevel === level) {
        return;
      }
      if (fantasyMoneyValue < cost) {
        showToast("NOT ENOUGH MONEY!", "#ef4444");
        return;
      }
      equippedFantasyLevel = level;
      setMoney(fantasyMoneyValue - cost);
      renderFantasyShop();
      showToast(`Level ${level} equipped!`);
    });
    fantasyShopGrid.append(button);
  }
}

const tutorialTexts = [
  "Welcome to Merge Guys!",
  "Use W, A, S, D or Arrow Keys to move around in Fantasy Mode.",
  "Click and drag a box around your guys to merge them in Normal Mode.",
  "Merged guys reach higher levels, shoot faster, and hit harder.",
  "Normal Mode: defend your base against zombie waves.",
  "Fantasy Mode: fight bots in a massive arena and avoid the dragon.",
  "Collect food, grow stronger, and survive.",
];

function drawTutorial(): void {
  tutorialContext.fillStyle = "#022c22";
  tutorialContext.fillRect(0, 0, tutorialCanvas.width, tutorialCanvas.height);
  tutorialContext.strokeStyle = "rgb(5 150 105 / 25%)";
  for (let x = 0; x < tutorialCanvas.width; x += 40) {
    tutorialContext.beginPath();
    tutorialContext.moveTo(x, 0);
    tutorialContext.lineTo(x, tutorialCanvas.height);
    tutorialContext.stroke();
  }
  for (let y = 0; y < tutorialCanvas.height; y += 40) {
    tutorialContext.beginPath();
    tutorialContext.moveTo(0, y);
    tutorialContext.lineTo(tutorialCanvas.width, y);
    tutorialContext.stroke();
  }
  const time = performance.now() / 500;
  const x = 400 + Math.cos(time) * 140;
  const y = 190 + Math.sin(time * 1.3) * 70;
  const level = 1 + (tutorialStep % 6);
  const drawDemoGuy = (gx: number, gy: number, bot = false): void => {
    tutorialContext.fillStyle = bot ? "#ef4444" : "#34d399";
    tutorialContext.beginPath();
    tutorialContext.arc(gx, gy, 20 + level, 0, Math.PI * 2);
    tutorialContext.fill();
    tutorialContext.strokeStyle = "#020617";
    tutorialContext.stroke();
    tutorialContext.fillStyle = "#fff";
    tutorialContext.font = "bold 14px Arial";
    tutorialContext.textAlign = "center";
    tutorialContext.textBaseline = "middle";
    tutorialContext.fillText(`L${level}`, gx, gy);
  };
  drawDemoGuy(x, y);
  drawDemoGuy(260, 210, tutorialStep > 4);
  drawDemoGuy(540, 210, tutorialStep > 4);
  if (tutorialStep === 2 || tutorialStep === 3) {
    tutorialContext.fillStyle = "rgb(52 211 153 / 24%)";
    tutorialContext.strokeStyle = "#34d399";
    tutorialContext.fillRect(220, 145, 360, 135);
    tutorialContext.strokeRect(220, 145, 360, 135);
  }
  if (tutorialStep > 3) {
    for (let index = 0; index < 5; index += 1) {
      tutorialContext.fillStyle = "#fef08a";
      tutorialContext.beginPath();
      tutorialContext.arc(320 + ((performance.now() / 3 + index * 105) % 260), 205 + Math.sin(time + index) * 35, 5, 0, Math.PI * 2);
      tutorialContext.fill();
    }
  }
  tutorialId = requestAnimationFrame(drawTutorial);
}

function renderTutorialStep(): void {
  tutorialScreenText.textContent = tutorialTexts[tutorialStep];
  tutorialDots.innerHTML = "";
  tutorialTexts.forEach((_, index) => {
    const dot = document.createElement("div");
    dot.className = `dot ${index === tutorialStep ? "active" : ""}`;
    tutorialDots.append(dot);
  });
}

function startTutorial(): void {
  tutorialStep = 0;
  renderTutorialStep();
  show(tutorialScreen);
  cancelAnimationFrame(tutorialId);
  drawTutorial();
  clearInterval(tutorialTimer);
  tutorialTimer = window.setInterval(() => {
    tutorialStep += 1;
    if (tutorialStep >= tutorialTexts.length) {
      closeTutorial();
      return;
    }
    renderTutorialStep();
  }, 3300);
}

function closeTutorial(): void {
  hide(tutorialScreen);
  clearInterval(tutorialTimer);
  cancelAnimationFrame(tutorialId);
}

function pointerOnUI(event: MouseEvent | TouchEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(target?.closest("button,input,.panel,.hud-row,.fantasy-stats,.minimap"));
}

function canvasDown(event: MouseEvent): void {
  if (!isPlaying || isPaused || pointerOnUI(event)) {
    return;
  }
  mouse.down = true;
  mouse.startX = event.clientX;
  mouse.startY = event.clientY;
  mouse.x = event.clientX;
  mouse.y = event.clientY;
  if (mode === "normal") {
    draggingGuy = [...guys].reverse().find((guy) => dist(event.clientX, event.clientY, guy.x, guy.y) < guy.radius) ?? null;
    if (!draggingGuy) {
      dragRect = { x: event.clientX, y: event.clientY, w: 0, h: 0 };
    }
  }
}

function canvasMove(event: MouseEvent): void {
  mouse.x = event.clientX;
  mouse.y = event.clientY;
  if (draggingGuy) {
    draggingGuy.x = event.clientX;
    draggingGuy.y = event.clientY;
  } else if (dragRect && mouse.down) {
    dragRect.w = event.clientX - dragRect.x;
    dragRect.h = event.clientY - dragRect.y;
  }
}

function mergeGuys(selected: Guy[]): void {
  if (selected.length < 2) {
    return;
  }
  selected.sort((a, b) => b.level - a.level);
  const main = selected[0];
  const gained = selected.slice(1).reduce((sum, guy) => sum + guy.level, 0);
  for (const guy of selected.slice(1)) {
    const index = guys.indexOf(guy);
    if (index >= 0) {
      guys.splice(index, 1);
    }
  }
  updateGuyLevel(main, main.level + Math.max(1, Math.floor(gained / 2)));
  addFloatText("MERGED!", main.x, main.y - 34, "#fef08a");
  tone(660, 0.09, 0.06);
}

function canvasUp(): void {
  if (!mouse.down) {
    return;
  }
  mouse.down = false;
  if (draggingGuy) {
    const target = guys.find((guy) => guy !== draggingGuy && dist(guy.x, guy.y, draggingGuy!.x, draggingGuy!.y) < guy.radius * 2);
    if (target) {
      updateGuyLevel(target, target.level + Math.max(1, Math.floor(draggingGuy.level)));
      guys.splice(guys.indexOf(draggingGuy), 1);
      addFloatText("MERGED!", target.x, target.y - 34, "#fef08a");
      tone(660, 0.09, 0.06);
    }
    draggingGuy = null;
  } else if (dragRect) {
    const minX = Math.min(dragRect.x, dragRect.x + dragRect.w);
    const maxX = Math.max(dragRect.x, dragRect.x + dragRect.w);
    const minY = Math.min(dragRect.y, dragRect.y + dragRect.h);
    const maxY = Math.max(dragRect.y, dragRect.y + dragRect.h);
    mergeGuys(guys.filter((guy) => guy.x >= minX && guy.x <= maxX && guy.y >= minY && guy.y <= maxY));
    dragRect = null;
  }
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => keys.add(event.key.toLowerCase()));
window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => {
  keys.clear();
  mouse.down = false;
  draggingGuy = null;
  dragRect = null;
});
gameCanvas.addEventListener("mousedown", canvasDown);
gameCanvas.addEventListener("mousemove", canvasMove);
gameCanvas.addEventListener("mouseup", canvasUp);
gameCanvas.addEventListener("mouseleave", canvasUp);

usernameInput.value = localStorage.getItem(storageKeys.username) ?? "";
setMoney(fantasyMoneyValue);
resizeCanvas();
draw();

usernameInput.addEventListener("input", () => localStorage.setItem(storageKeys.username, usernameInput.value.trim()));
playBtn.addEventListener("click", () => {
  if (!usernameInput.value.trim()) {
    show(nameError);
    window.setTimeout(() => hide(nameError), 2000);
    return;
  }
  username = usernameInput.value.trim();
  localStorage.setItem(storageKeys.username, username);
  hide(startScreen);
  show(rulesScreen);
  hide(nameError);
  usernameInput.blur();
  if (musicEnabled) {
    startMusic();
  }
});
rulesBackBtn.addEventListener("click", () => {
  hide(rulesScreen);
  show(startScreen);
});
normalModeBtn.addEventListener("click", startNormal);
fantasyShopBtn.addEventListener("click", () => {
  hide(rulesScreen);
  show(fantasyShopScreen);
  renderFantasyShop();
  updateUI();
});
closeFantasyShopBtn.addEventListener("click", () => {
  hide(fantasyShopScreen);
  show(rulesScreen);
});
startFightBtn.addEventListener("click", () => {
  hide(fantasyShopScreen);
  show(matchmakingScreen);
  let count = 5;
  countdownTimer.textContent = String(count);
  playerCountText.textContent = "1/10";
  clearInterval(matchmakingId);
  matchmakingId = window.setInterval(() => {
    count -= 1;
    countdownTimer.textContent = String(count);
    if (count <= 0) {
      clearInterval(matchmakingId);
      launchFantasy();
    }
  }, 1000);
});
cancelMatchBtn.addEventListener("click", () => {
  clearInterval(matchmakingId);
  hide(matchmakingScreen);
  show(fantasyShopScreen);
});
leaderboardBtn.addEventListener("click", () => {
  renderLeaderboard();
  show(leaderboardScreen);
});
closeLeaderboardBtn.addEventListener("click", () => hide(leaderboardScreen));
tutorialBtn.addEventListener("click", startTutorial);
closeTutorialBtn.addEventListener("click", closeTutorial);
homeBtn.addEventListener("click", () => {
  isPaused = true;
  show(quitConfirmScreen);
});
cancelQuitBtn.addEventListener("click", () => {
  isPaused = false;
  hide(quitConfirmScreen);
});
confirmQuitBtn.addEventListener("click", resetToMenu);
restartBtn.addEventListener("click", resetToMenu);
leaveFantasyBtn.addEventListener("click", resetToMenu);
buyLvl1Btn.addEventListener("click", () => buyNormalGuy(1));
buyLvl2Btn.addEventListener("click", () => buyNormalGuy(2));
buyLvl3Btn.addEventListener("click", () => buyNormalGuy(3));
enterShelterBtn.addEventListener("click", () => {
  if (!player) {
    return;
  }
  if (fantasyMoneyValue < shelter.cost) {
    showToast("Need $60,000 to enter shelter.", "#ef4444");
    return;
  }
  setMoney(fantasyMoneyValue - shelter.cost);
  player.x = shelter.x;
  player.y = shelter.y;
  inShelter = true;
  shelterStartedAt = performance.now();
  hide(enterShelterBtn);
  showToast("Shelter entered.");
});
musicBtn.addEventListener("click", () => {
  musicEnabled = !musicEnabled;
  musicBtn.textContent = musicEnabled ? "Music: On" : "Music: Off";
  if (musicEnabled) {
    startMusic();
  } else {
    stopMusic();
  }
});

requestAnimationFrame(gameLoop);

export {};
