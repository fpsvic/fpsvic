/** Smoothed FPS sampling + optional on-screen readout (uncapped frame times). */
export class FpsMeter {
  visible = false;
  smoothedFps = 60;
  instantFps = 60;
  private readonly updateDom: (fps: number) => void;
  private domFrame = 0;
  private lastSampleTime = performance.now();

  constructor(updateDom: (fps: number) => void) {
    this.updateDom = updateDom;
  }

  toggleVisible(): boolean {
    this.visible = !this.visible;
    if (this.visible) {
      this.domFrame = 0;
      this.updateDom(Math.round(this.smoothedFps));
    }
    return this.visible;
  }

  /** Call once per rendered frame (uses real wall-clock time, not physics delta). */
  beginFrame(): void {
    const now = performance.now();
    const frameSeconds = (now - this.lastSampleTime) / 1000;
    this.lastSampleTime = now;

    if (frameSeconds > 0.0001 && frameSeconds < 1) {
      const instant = 1 / frameSeconds;
      this.instantFps = instant;
      this.smoothedFps = this.smoothedFps * 0.88 + instant * 0.12;
    }

    if (!this.visible) {
      return;
    }

    this.domFrame += 1;
    if (this.domFrame % 4 === 0) {
      this.updateDom(Math.round(this.smoothedFps));
    }
  }
}
