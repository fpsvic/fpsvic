/** FPS readout: counts completed renders over wall-clock windows (matches perceived smoothness). */
export class FpsMeter {
  visible = false;
  smoothedFps = 60;
  instantFps = 60;
  private readonly updateDom: (fps: number) => void;
  private framesInPeriod = 0;
  private periodStart = 0;

  constructor(updateDom: (fps: number) => void) {
    this.updateDom = updateDom;
    this.reset();
  }

  reset(): void {
    this.framesInPeriod = 0;
    this.periodStart = performance.now();
    this.smoothedFps = 60;
    this.instantFps = 60;
  }

  toggleVisible(): boolean {
    this.visible = !this.visible;
    if (this.visible) {
      this.updateDom(Math.round(this.smoothedFps));
    }
    return this.visible;
  }

  /** Call once after each `renderer.render` completes. */
  endFrame(): void {
    this.framesInPeriod += 1;
    const now = performance.now();
    const elapsed = now - this.periodStart;
    if (elapsed < 350) {
      return;
    }

    const measured = (this.framesInPeriod / elapsed) * 1000;
    this.framesInPeriod = 0;
    this.periodStart = now;

    if (!Number.isFinite(measured) || measured <= 0) {
      return;
    }

    this.instantFps = measured;
    this.smoothedFps = this.smoothedFps * 0.55 + measured * 0.45;

    if (this.visible) {
      this.updateDom(Math.round(this.smoothedFps));
    }
  }
}
