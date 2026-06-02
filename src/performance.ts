import type * as THREE from "three";

export type PerformanceTuning = {
  shadowFrameInterval: number;
  minimapFrameInterval: number;
  pickupFrameInterval: number;
  hudFrameInterval: number;
  enemyFarSkipInterval: number;
  enemyAnimInterval: number;
  cameraIdleInterval: number;
};

export type RenderQuality = {
  tuning: PerformanceTuning;
  shadowsEnabled: boolean;
  pixelRatioCap: number;
};

export function getRenderQuality(smoothedFps: number): RenderQuality {
  if (smoothedFps < 56) {
    return {
      shadowsEnabled: false,
      pixelRatioCap: 0.72,
      tuning: {
        shadowFrameInterval: 8,
        minimapFrameInterval: 14,
        pickupFrameInterval: 7,
        hudFrameInterval: 7,
        enemyFarSkipInterval: 5,
        enemyAnimInterval: 4,
        cameraIdleInterval: 4,
      },
    };
  }

  if (smoothedFps < 68) {
    return {
      shadowsEnabled: true,
      pixelRatioCap: 0.8,
      tuning: {
        shadowFrameInterval: 6,
        minimapFrameInterval: 10,
        pickupFrameInterval: 6,
        hudFrameInterval: 6,
        enemyFarSkipInterval: 4,
        enemyAnimInterval: 3,
        cameraIdleInterval: 3,
      },
    };
  }

  if (smoothedFps < 82) {
    return {
      shadowsEnabled: true,
      pixelRatioCap: 0.88,
      tuning: {
        shadowFrameInterval: 4,
        minimapFrameInterval: 8,
        pickupFrameInterval: 5,
        hudFrameInterval: 5,
        enemyFarSkipInterval: 3,
        enemyAnimInterval: 2,
        cameraIdleInterval: 2,
      },
    };
  }

  return {
    shadowsEnabled: true,
    pixelRatioCap: Math.min(window.devicePixelRatio || 1, 1),
    tuning: {
      shadowFrameInterval: 3,
      minimapFrameInterval: 6,
      pickupFrameInterval: 4,
      hudFrameInterval: 4,
      enemyFarSkipInterval: 3,
      enemyAnimInterval: 2,
      cameraIdleInterval: 2,
    },
  };
}

export function applyAdaptivePixelRatio(
  renderer: THREE.WebGLRenderer,
  cap: number,
  currentRatio: number,
): number {
  const next = Math.min(cap, window.devicePixelRatio || 1);
  if (Math.abs(next - currentRatio) > 0.02) {
    renderer.setPixelRatio(next);
  }
  return next;
}

let shadowsSynced: boolean | null = null;

export function syncShadowRendering(
  renderer: THREE.WebGLRenderer,
  sun: THREE.DirectionalLight,
  terrainMesh: THREE.Mesh,
  enabled: boolean,
): void {
  if (shadowsSynced === enabled) {
    return;
  }
  shadowsSynced = enabled;
  renderer.shadowMap.enabled = enabled;
  sun.castShadow = enabled;
  terrainMesh.receiveShadow = enabled;
}
