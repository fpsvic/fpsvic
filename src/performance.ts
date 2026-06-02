import type * as THREE from "three";

export type PerformanceTuning = {
  shadowFrameInterval: number;
  minimapFrameInterval: number;
  pickupFrameInterval: number;
  hudFrameInterval: number;
  enemyFarSkipInterval: number;
};

export function getPerformanceTuning(smoothedFps: number): PerformanceTuning {
  if (smoothedFps < 52) {
    return {
      shadowFrameInterval: 4,
      minimapFrameInterval: 10,
      pickupFrameInterval: 6,
      hudFrameInterval: 6,
      enemyFarSkipInterval: 5,
    };
  }
  if (smoothedFps < 68) {
    return {
      shadowFrameInterval: 3,
      minimapFrameInterval: 8,
      pickupFrameInterval: 5,
      hudFrameInterval: 5,
      enemyFarSkipInterval: 4,
    };
  }
  return {
    shadowFrameInterval: 2,
    minimapFrameInterval: 6,
    pickupFrameInterval: 4,
    hudFrameInterval: 4,
    enemyFarSkipInterval: 3,
  };
}

export function applyAdaptivePixelRatio(
  renderer: THREE.WebGLRenderer,
  smoothedFps: number,
  currentRatio: number,
): number {
  let next = currentRatio;
  if (smoothedFps < 50) {
    next = Math.min(next, 0.75);
  } else if (smoothedFps < 62) {
    next = Math.min(next, 0.85);
  } else if (smoothedFps > 100) {
    next = Math.min(window.devicePixelRatio || 1, 1);
  }

  if (Math.abs(next - currentRatio) > 0.02) {
    renderer.setPixelRatio(next);
  }
  return next;
}
