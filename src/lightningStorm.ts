import * as THREE from "three";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";

export const LIGHTNING_STORM_CHANCE = 0.1;
export const LIGHTNING_STRIKE_CHANCE = 0.03;
export const LIGHTNING_STRIKE_DAMAGE = 50;

type StrikeFlash = {
  group: THREE.Group;
  life: number;
  flashLight: THREE.PointLight;
};

function drawLightningBranch(
  brush: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  widthPx: number,
  depth: number,
): void {
    if (depth <= 0) {
      return;
    }

    const gradient = brush.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, "rgba(180,220,255,0.15)");
    gradient.addColorStop(0.35, "rgba(220,245,255,0.95)");
    gradient.addColorStop(0.55, "rgba(255,255,255,1)");
    gradient.addColorStop(1, "rgba(120,180,255,0.2)");

    brush.strokeStyle = gradient;
    brush.lineWidth = widthPx;
    brush.lineCap = "round";
    brush.shadowBlur = widthPx * 2.4;
    brush.shadowColor = "rgba(140,210,255,0.95)";
    brush.beginPath();
    brush.moveTo(x0, y0);

    const segments = 7 + Math.floor(Math.random() * 4);
    for (let index = 1; index <= segments; index += 1) {
      const t = index / segments;
      const x = THREE.MathUtils.lerp(x0, x1, t) + (Math.random() - 0.5) * 18;
      const y = THREE.MathUtils.lerp(y0, y1, t) + (Math.random() - 0.5) * 10;
      brush.lineTo(x, y);
    }
    brush.stroke();

    if (depth > 1 && Math.random() > 0.35) {
      const forkT = 0.35 + Math.random() * 0.35;
      const fx = THREE.MathUtils.lerp(x0, x1, forkT) + (Math.random() - 0.5) * 20;
      const fy = THREE.MathUtils.lerp(y0, y1, forkT);
      const angle = (Math.random() - 0.5) * 1.4;
      const len = 40 + Math.random() * 70;
      drawLightningBranch(
        brush,
        fx,
        fy,
        fx + Math.cos(angle) * len,
        fy + Math.sin(angle) * len,
        widthPx * 0.55,
        depth - 1,
      );
    }
}

function createLightningBoltTexture(): THREE.CanvasTexture {
  const width = 192;
  const height = 384;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const brush = canvas.getContext("2d");
  if (!brush) {
    throw new Error("Unable to create lightning texture.");
  }

  brush.clearRect(0, 0, width, height);
  brush.globalCompositeOperation = "lighter";

  drawLightningBranch(brush, width * 0.52, height * 0.04, width * 0.48, height * 0.94, 7, 4);
  drawLightningBranch(brush, width * 0.56, height * 0.12, width * 0.72, height * 0.55, 4.5, 3);
  drawLightningBranch(brush, width * 0.44, height * 0.2, width * 0.22, height * 0.62, 4, 3);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export type LightningStormHooks = {
  onPlayerStruck: () => void;
  onStrikeNearby: (x: number, z: number) => void;
};

export type LightningStormLighting = {
  sun: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
};

export class LightningStormSystem {
  readonly group = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly daySky: THREE.Color;
  private readonly nightSky = new THREE.Color(0x070d1c);
  private readonly dayFogDensity = 0.0032;
  private readonly nightFogDensity = 0.0068;
  private readonly lighting: LightningStormLighting;
  private readonly hooks: LightningStormHooks;
  private readonly boltTexture: THREE.CanvasTexture;
  private readonly strikes: StrikeFlash[] = [];
  private stormActive = false;
  private nightBlend = 0;
  private timeUntilStorm = 55 + Math.random() * 45;
  private stormTimeLeft = 0;
  private nextStrikeIn = 2.5;
  private sunDayIntensity = 1.95;
  private fillDayIntensity = 0.48;
  private hemiDayIntensity = 0.78;
  private ambientDayIntensity = 0.28;
  private readonly daySunColor = new THREE.Color(0xfff0d0);

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    daySkyColor: THREE.Color,
    lighting: LightningStormLighting,
    hooks: LightningStormHooks,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.daySky = daySkyColor.clone();
    this.lighting = lighting;
    this.hooks = hooks;
    this.boltTexture = createLightningBoltTexture();
    this.sunDayIntensity = lighting.sun.intensity;
    this.fillDayIntensity = lighting.fill.intensity;
    this.hemiDayIntensity = lighting.hemisphere.intensity;
    this.ambientDayIntensity = lighting.ambient.intensity;
    scene.add(this.group);
  }

  get isStormActive(): boolean {
    return this.stormActive;
  }

  get nightLevel(): number {
    return this.nightBlend;
  }

  reset(): void {
    this.stormActive = false;
    this.nightBlend = 0;
    this.timeUntilStorm = 60 + Math.random() * 50;
    this.stormTimeLeft = 0;
    this.nextStrikeIn = 2.5;
    this.clearStrikes();
    this.applyAtmosphere(0);
  }

  update(delta: number, playerX: number, playerZ: number, underShelter: boolean): void {
    if (!this.stormActive) {
      this.timeUntilStorm -= delta;
      this.nightBlend = THREE.MathUtils.damp(this.nightBlend, 0, 3.5, delta);
      this.applyAtmosphere(this.nightBlend);
      if (this.timeUntilStorm <= 0) {
        if (Math.random() < LIGHTNING_STORM_CHANCE) {
          this.beginStorm();
        } else {
          this.scheduleNextStormWindow();
        }
      }
      this.tickStrikes(delta);
      return;
    }

    this.stormTimeLeft -= delta;
    this.nightBlend = THREE.MathUtils.damp(this.nightBlend, 1, 2.2, delta);
    this.applyAtmosphere(this.nightBlend);
    this.nextStrikeIn -= delta;

    if (this.nextStrikeIn <= 0) {
      this.triggerStrike(playerX, playerZ, underShelter);
      this.nextStrikeIn = 1.6 + Math.random() * 3.2;
    }

    if (this.stormTimeLeft <= 0) {
      this.stormActive = false;
      this.scheduleNextStormWindow();
    }

    this.tickStrikes(delta);
  }

  private scheduleNextStormWindow(): void {
    this.timeUntilStorm = 55 + Math.random() * 45;
  }

  private beginStorm(): void {
    this.stormActive = true;
    this.stormTimeLeft = 26 + Math.random() * 18;
    this.nextStrikeIn = 0.6 + Math.random() * 1.4;
  }

  private applyAtmosphere(blend: number): void {
    const sky = this.daySky.clone().lerp(this.nightSky, blend);
    this.scene.background = sky;

    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.color.copy(sky);
      fog.density = THREE.MathUtils.lerp(this.dayFogDensity, this.nightFogDensity, blend);
    }

    const { sun, fill, hemisphere, ambient } = this.lighting;
    sun.intensity = THREE.MathUtils.lerp(this.sunDayIntensity, 0.08, blend);
    fill.intensity = THREE.MathUtils.lerp(this.fillDayIntensity, 0.12, blend);
    hemisphere.intensity = THREE.MathUtils.lerp(this.hemiDayIntensity, 0.22, blend);
    ambient.intensity = THREE.MathUtils.lerp(this.ambientDayIntensity, 0.12, blend);
    sun.color.copy(this.daySunColor).lerp(new THREE.Color(0x6a88c8), blend);
  }

  private triggerStrike(playerX: number, playerZ: number, underShelter: boolean): void {
    const strikeNearPlayer = Math.random() < 0.42;
    let strikeX: number;
    let strikeZ: number;

    if (strikeNearPlayer) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 4 + Math.random() * 16;
      strikeX = playerX + Math.cos(angle) * radius;
      strikeZ = playerZ + Math.sin(angle) * radius;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const radius = 18 + Math.random() * (ARENA_RADIUS * 0.72);
      strikeX = Math.cos(angle) * radius;
      strikeZ = Math.sin(angle) * radius;
    }

    const distToPlayer = Math.hypot(strikeX - playerX, strikeZ - playerZ);
    this.spawnBoltVisual(strikeX, strikeZ);
    this.hooks.onStrikeNearby(strikeX, strikeZ);

    if (!underShelter && Math.random() < LIGHTNING_STRIKE_CHANCE) {
      this.hooks.onPlayerStruck();
      this.spawnBoltVisual(playerX, playerZ, true);
    } else if (distToPlayer < 10) {
      this.spawnBoltVisual(playerX + (Math.random() - 0.5) * 3, playerZ + (Math.random() - 0.5) * 3);
    }
  }

  private spawnBoltVisual(x: number, z: number, directHit = false): void {
    const groundY = sampleTerrainHeight(x, z);
    const flashGroup = new THREE.Group();
    flashGroup.position.set(x, groundY, z);

    const spriteMat = new THREE.SpriteMaterial({
      map: this.boltTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: directHit ? 1 : 0.92,
      color: directHit ? 0xffffff : 0xd8ecff,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(directHit ? 10 : 14, directHit ? 24 : 30, 1);
    sprite.position.y = 14;
    flashGroup.add(sprite);

    if (Math.random() > 0.25) {
      const branchMat = spriteMat.clone();
      branchMat.opacity = 0.75;
      const branch = new THREE.Sprite(branchMat);
      branch.scale.set(8, 16, 1);
      branch.position.set((Math.random() - 0.5) * 8, 10 + Math.random() * 6, 0);
      branch.rotation.z = (Math.random() - 0.5) * 0.8;
      flashGroup.add(branch);
    }

    const flashLight = new THREE.PointLight(0xb8e8ff, directHit ? 4.5 : 2.8, 38, 2);
    flashLight.position.y = 12;
    flashGroup.add(flashLight);

    this.group.add(flashGroup);
    this.strikes.push({
      group: flashGroup,
      life: directHit ? 0.42 : 0.28,
      flashLight,
    });
  }

  private tickStrikes(delta: number): void {
    for (let index = this.strikes.length - 1; index >= 0; index -= 1) {
      const strike = this.strikes[index];
      strike.life -= delta;
      const fade = THREE.MathUtils.clamp(strike.life / 0.35, 0, 1);
      strike.flashLight.intensity *= 0.9;
      strike.group.children.forEach((child) => {
        if (child instanceof THREE.Sprite) {
          child.material.opacity = fade;
        }
      });
      strike.group.lookAt(this.camera.position);
      if (strike.life <= 0) {
        this.group.remove(strike.group);
        strike.group.children.forEach((child) => {
          if (child instanceof THREE.Sprite) {
            child.material.dispose();
          }
        });
        this.strikes.splice(index, 1);
      }
    }
  }

  private clearStrikes(): void {
    for (const strike of this.strikes) {
      this.group.remove(strike.group);
    }
    this.strikes.length = 0;
  }
}
