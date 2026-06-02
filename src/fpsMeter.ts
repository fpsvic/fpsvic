/** Honest redraw FPS — what you see is how often the game actually draws. */
export type FpsHudMeta = {
  frameMs: number;
  embedded: boolean;
};

export class FpsMeter {
  visible = false;
  smoothedFps = 0;
  renderSmoothedFps = 0;
  renderInstantFps = 0;
  private readonly updateDom: (fps: number, meta: FpsHudMeta) => void;
  private lastFrameEnd = 0;
  private domTick = 0;

  constructor(updateDom: (fps: number, meta: FpsHudMeta) => void) {
    this.updateDom = updateDom;
    this.reset();
  }

  reset(): void {
    this.lastFrameEnd = performance.now();
    this.smoothedFps = 0;
    this.renderSmoothedFps = 0;
    this.renderInstantFps = 0;
    this.domTick = 0;
  }

  toggleVisible(): boolean {
    this.visible = !this.visible;
    if (this.visible) {
      this.pushDom(true);
    }
    return this.visible;
  }

  /** Call once after each `renderer.render`. */
  endRenderFrame(): void {
    const now = performance.now();
    const frameMs = now - this.lastFrameEnd;
    this.lastFrameEnd = now;

    if (frameMs <= 0.0005 || frameMs >= 500) {
      return;
    }

    const instant = 1000 / frameMs;
    this.renderInstantFps = instant;
    this.renderSmoothedFps = this.renderSmoothedFps * 0.8 + instant * 0.2;
    this.smoothedFps = Math.round(this.renderSmoothedFps);

    if (!this.visible) {
      return;
    }

    this.domTick += 1;
    if (this.domTick % 4 === 0) {
      this.pushDom(false);
    }
  }

  private pushDom(force: boolean): void {
    const fps = Math.round(this.renderSmoothedFps);
    const frameMs = Math.round(1000 / Math.max(this.renderSmoothedFps, 1));
    this.updateDom(fps, {
      frameMs,
      embedded: isEmbeddedPreview(),
    });
    if (force) {
      return;
    }
  }
}

function isEmbeddedPreview(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
