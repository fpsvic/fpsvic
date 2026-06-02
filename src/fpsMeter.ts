/** FPS overlay — reports display refresh when rAF is throttled (common in Desktop iframes). */
export type FpsHudMeta = {
  redrawFps: number;
  screenHz: number;
};

export class FpsMeter {
  visible = false;
  smoothedFps = 60;
  renderSmoothedFps = 60;
  renderInstantFps = 60;
  private readonly updateDom: (fps: number, meta: FpsHudMeta) => void;
  private lastFrameEnd = 0;
  private readonly screenHz: number;

  constructor(updateDom: (fps: number, meta: FpsHudMeta) => void) {
    this.updateDom = updateDom;
    this.screenHz = readScreenRefreshHz();
    this.reset();
  }

  reset(): void {
    this.lastFrameEnd = performance.now();
    this.smoothedFps = this.screenHz;
    this.renderSmoothedFps = 60;
    this.renderInstantFps = 60;
  }

  toggleVisible(): boolean {
    this.visible = !this.visible;
    if (this.visible) {
      this.publish();
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

    if (frameMs > 0) {
      const instant = 1000 / frameMs;
      this.renderInstantFps = instant;
      this.renderSmoothedFps = this.renderSmoothedFps * 0.82 + instant * 0.18;
    }

    this.publish();
  }

  private publish(): void {
    const redraw = Math.round(this.renderSmoothedFps);
    const measured = redraw;
    const reported =
      measured < 24 && this.screenHz >= 48 ? this.screenHz : measured;
    this.smoothedFps = reported;

    const meta: FpsHudMeta = {
      redrawFps: redraw,
      screenHz: this.screenHz,
    };

    if (!this.visible) {
      return;
    }
    this.updateDom(reported, meta);
  }
}

function readScreenRefreshHz(): number {
  const screen = window.screen as Screen & { refreshRate?: number };
  if (typeof screen.refreshRate === "number" && screen.refreshRate >= 30) {
    return Math.round(screen.refreshRate);
  }
  return 60;
}
