/** Lightweight frame profiler + adaptive quality (no engine required). */

export type ProfileSection =
  | "input"
  | "enemies"
  | "pickups"
  | "storm"
  | "weapon"
  | "slash"
  | "camera"
  | "hud"
  | "render";

export type PerformanceTuning = {
  enemyAiInterval: number;
  enemyAnimInterval: number;
  pickupInterval: number;
  hudInterval: number;
  shadowInterval: number;
  messageInterval: number;
};

export type RenderQuality = {
  pixelRatioCap: number;
  shadowMapSize: number;
  tuning: PerformanceTuning;
};

const SECTIONS: ProfileSection[] = [
  "input",
  "enemies",
  "pickups",
  "storm",
  "weapon",
  "slash",
  "camera",
  "hud",
  "render",
];

export class FrameProfiler {
  private readonly totals = new Map<ProfileSection, number>();
  private frameMs = 0;
  private smoothedFps = 60;
  private showPanel = false;
  private sampleFrames = 0;

  constructor(private readonly onReport?: (lines: string[], fps: number, frameMs: number) => void) {
    for (const section of SECTIONS) {
      this.totals.set(section, 0);
    }
  }

  setVisible(visible: boolean): void {
    this.showPanel = visible;
    if (visible) {
      this.sampleFrames = 0;
      for (const section of SECTIONS) {
        this.totals.set(section, 0);
      }
    }
  }

  get visible(): boolean {
    return this.showPanel;
  }

  get fps(): number {
    return Math.round(this.smoothedFps);
  }

  beginFrame(): void {
    this.frameMs = performance.now();
  }

  endFrame(): void {
    const elapsed = performance.now() - this.frameMs;
    this.smoothedFps = this.smoothedFps * 0.9 + (1000 / Math.max(elapsed, 0.001)) * 0.1;
    if (!this.showPanel || !this.onReport) {
      return;
    }
    this.reportSample(elapsed);
  }

  private reportSample(elapsed: number): void {
    if (!this.onReport) {
      return;
    }
    this.sampleFrames += 1;
    if (this.sampleFrames < 30) {
      return;
    }
    this.sampleFrames = 0;
    const lines = SECTIONS.map((section) => {
      const ms = this.totals.get(section) ?? 0;
      return `${section.padEnd(8)} ${(ms / 30).toFixed(2)} ms`;
    }).sort((a, b) => parseFloat(b.split(" ")[1]) - parseFloat(a.split(" ")[1]));
    for (const section of SECTIONS) {
      this.totals.set(section, 0);
    }
    this.onReport(lines, this.fps, elapsed);
  }

  measure<T>(section: ProfileSection, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const elapsed = performance.now() - start;
    this.totals.set(section, (this.totals.get(section) ?? 0) + elapsed);
    return result;
  }
}

export function getRenderQuality(effectiveFps: number): RenderQuality {
  if (effectiveFps < 40) {
    return {
      pixelRatioCap: 0.75,
      shadowMapSize: 512,
      tuning: {
        enemyAiInterval: 3,
        enemyAnimInterval: 6,
        pickupInterval: 4,
        hudInterval: 6,
        shadowInterval: 10,
        messageInterval: 12,
      },
    };
  }
  if (effectiveFps < 55) {
    return {
      pixelRatioCap: 1,
      shadowMapSize: 768,
      tuning: {
        enemyAiInterval: 2,
        enemyAnimInterval: 4,
        pickupInterval: 3,
        hudInterval: 4,
        shadowInterval: 6,
        messageInterval: 8,
      },
    };
  }
  return {
    pixelRatioCap: 1.25,
    shadowMapSize: 1024,
    tuning: {
      enemyAiInterval: 1,
      enemyAnimInterval: 2,
      pickupInterval: 2,
      hudInterval: 3,
      shadowInterval: 4,
      messageInterval: 6,
    },
  };
}
