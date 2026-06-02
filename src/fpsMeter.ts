/** Smoothed FPS sampling + optional on-screen readout. */
export class FpsMeter {
  visible = false;
  smoothedFps = 60;
  private readonly updateDom: (fps: number) => void;
  private domFrame = 0;

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

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.updateDom(Math.round(this.smoothedFps));
    }
  }

  sample(delta: number): void {
    if (delta > 0.0001) {
      const instant = 1 / delta;
      this.smoothedFps = this.smoothedFps * 0.9 + instant * 0.1;
    }

    if (!this.visible) {
      return;
    }

    this.domFrame += 1;
    if (this.domFrame % 6 === 0) {
      this.updateDom(Math.round(this.smoothedFps));
    }
  }
}
