/** FPS overlay: display refresh (smoothness) + render rate (simulation). */
export class FpsMeter {
  visible = false;
  /** Shown in HUD — matches perceived smoothness (browser refresh). */
  smoothedFps = 60;
  /** Used for adaptive quality (how often we call render). */
  renderSmoothedFps = 60;
  renderInstantFps = 60;
  private readonly updateDom: (fps: number) => void;

  private renderFramesInPeriod = 0;
  private renderPeriodStart = 0;

  private displaySmoothedFps = 60;
  private rafFramesInPeriod = 0;
  private rafPeriodStart = 0;
  private rafHandle = 0;

  constructor(updateDom: (fps: number) => void) {
    this.updateDom = updateDom;
    this.reset();
  }

  reset(): void {
    this.renderFramesInPeriod = 0;
    this.renderPeriodStart = performance.now();
    this.rafFramesInPeriod = 0;
    this.rafPeriodStart = performance.now();
    this.smoothedFps = 60;
    this.renderSmoothedFps = 60;
    this.renderInstantFps = 60;
    this.displaySmoothedFps = 60;
  }

  startDisplayTracking(): void {
    this.stopDisplayTracking();
    this.rafPeriodStart = performance.now();
    const loop = (): void => {
      this.rafFramesInPeriod += 1;
      const now = performance.now();
      const elapsed = now - this.rafPeriodStart;
      if (elapsed >= 300) {
        const measured = (this.rafFramesInPeriod / elapsed) * 1000;
        this.rafFramesInPeriod = 0;
        this.rafPeriodStart = now;
        if (Number.isFinite(measured) && measured > 0) {
          this.displaySmoothedFps = this.displaySmoothedFps * 0.5 + measured * 0.5;
          this.publishDisplayFps();
        }
      }
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  stopDisplayTracking(): void {
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
  }

  toggleVisible(): boolean {
    this.visible = !this.visible;
    if (this.visible) {
      this.publishDisplayFps();
    }
    return this.visible;
  }

  /** After each `renderer.render` — drives adaptive quality, not the HUD number. */
  endRenderFrame(): void {
    this.renderFramesInPeriod += 1;
    const now = performance.now();
    const elapsed = now - this.renderPeriodStart;
    if (elapsed < 300) {
      return;
    }

    const measured = (this.renderFramesInPeriod / elapsed) * 1000;
    this.renderFramesInPeriod = 0;
    this.renderPeriodStart = now;

    if (!Number.isFinite(measured) || measured <= 0) {
      return;
    }

    this.renderInstantFps = measured;
    this.renderSmoothedFps = this.renderSmoothedFps * 0.55 + measured * 0.45;
    this.publishDisplayFps();
  }

  private publishDisplayFps(): void {
    const display = Math.round(this.displaySmoothedFps);
    const render = Math.round(this.renderSmoothedFps);
    this.smoothedFps = Math.max(display, render);
    if (!this.visible) {
      return;
    }
    this.updateDom(this.smoothedFps);
  }
}
