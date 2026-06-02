import * as THREE from "three";
import { ARENA_RADIUS, sampleTerrainHeight } from "./terrain";

export type MinimapSnapshot = {
  playerX: number;
  playerZ: number;
  playerYaw: number;
  stormRadius: number;
  enemies: ReadonlyArray<{ x: number; z: number }>;
  moveTargetX: number;
  moveTargetZ: number;
  hasMoveTarget: boolean;
};

const CANVAS_SIZE = 96;

function worldToMap(
  x: number,
  z: number,
  size: number,
  arenaRadius: number,
): { px: number; py: number } {
  const nx = x / arenaRadius;
  const nz = z / arenaRadius;
  return {
    px: ((nx + 1) * 0.5) * size,
    py: ((1 - nz) * 0.5) * size,
  };
}

function bakeTerrainLayer(size: number, arenaRadius: number): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = size;
  layer.height = size;
  const ctx = layer.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create minimap terrain layer.");
  }

  const image = ctx.createImageData(size, size);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const wx = (px / size - 0.5) * arenaRadius * 2;
      const wz = (0.5 - py / size) * arenaRadius * 2;
      const dist = Math.hypot(wx, wz);
      const index = (py * size + px) * 4;

      if (dist > arenaRadius + 1) {
        image.data[index] = 18;
        image.data[index + 1] = 28;
        image.data[index + 2] = 42;
        image.data[index + 3] = 255;
        continue;
      }

      const height = sampleTerrainHeight(wx, wz);
      const pathMask =
        THREE.MathUtils.smoothstep(dist, 4, 16) *
        (1 - THREE.MathUtils.smoothstep(dist, 16, 34));
      const heightNorm = THREE.MathUtils.clamp(height / 2.5, 0, 1);
      const rockMask = THREE.MathUtils.smoothstep(heightNorm, 0.42, 0.88);

      const grassR = 48 + height * 10;
      const grassG = 92 + height * 16;
      const grassB = 38 + height * 6;
      const pathR = 128;
      const pathG = 98;
      const pathB = 68;
      const rockR = 96;
      const rockG = 108;
      const rockB = 92;

      const dirtT = pathMask * 0.9;
      const rockT = rockMask * 0.55 * (1 - pathMask * 0.4);
      const grassT = 1 - dirtT - rockT;

      image.data[index] = Math.floor(grassR * grassT + pathR * dirtT + rockR * rockT);
      image.data[index + 1] = Math.floor(grassG * grassT + pathG * dirtT + rockG * rockT);
      image.data[index + 2] = Math.floor(grassB * grassT + pathB * dirtT + rockB * rockT);
      image.data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return layer;
}

export class ArenaMinimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrainLayer: HTMLCanvasElement;
  private readonly arenaRadius: number;
  private readonly mapRadiusPx: number;

  constructor(canvas: HTMLCanvasElement, arenaRadius = ARENA_RADIUS) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      throw new Error("Unable to create minimap context.");
    }

    this.ctx = ctx;
    this.arenaRadius = arenaRadius;
    this.mapRadiusPx = CANVAS_SIZE * 0.5 - 2;
    this.terrainLayer = bakeTerrainLayer(CANVAS_SIZE, arenaRadius);
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
  }

  draw(snapshot: MinimapSnapshot): void {
    const { ctx } = this;
    const size = CANVAS_SIZE;

    ctx.drawImage(this.terrainLayer, 0, 0);

    const center = worldToMap(0, 0, size, this.arenaRadius);
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.px, center.py, this.mapRadiusPx, 0, Math.PI * 2);
    ctx.stroke();

    const stormPx = (snapshot.stormRadius / this.arenaRadius) * this.mapRadiusPx;
    ctx.strokeStyle = "rgba(122, 90, 216, 0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(center.px, center.py, stormPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (snapshot.hasMoveTarget) {
      const target = worldToMap(snapshot.moveTargetX, snapshot.moveTargetZ, size, this.arenaRadius);
      ctx.fillStyle = "rgba(120, 232, 255, 0.9)";
      ctx.beginPath();
      ctx.arc(target.px, target.py, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const enemy of snapshot.enemies) {
      const point = worldToMap(enemy.x, enemy.z, size, this.arenaRadius);
      ctx.fillStyle = "#ff5a6a";
      ctx.beginPath();
      ctx.arc(point.px, point.py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const player = worldToMap(snapshot.playerX, snapshot.playerZ, size, this.arenaRadius);
    ctx.save();
    ctx.translate(player.px, player.py);
    ctx.rotate(-snapshot.playerYaw);
    ctx.fillStyle = "#56d6ff";
    ctx.strokeStyle = "#0a2838";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 3);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
