import type * as THREE from "three";
import {
  ensureSceneEnvironment,
  setSceneEnvironmentEnabled,
} from "./graphics";

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
  environmentEnabled: boolean;
  pixelRatioCap: number;
};

/** Use the higher of smoothed + instant so quality can recover when FPS improves. */
export function getEffectiveFps(smoothedFps: number, instantFps: number): number {
  return Math.max(smoothedFps, instantFps * 0.65);
}

export function getRenderQuality(effectiveFps: number): RenderQuality {
  if (effectiveFps < 48) {
    return {
      shadowsEnabled: false,
      environmentEnabled: false,
      pixelRatioCap: 0.62,
      tuning: {
        shadowFrameInterval: 8,
        minimapFrameInterval: 16,
        pickupFrameInterval: 8,
        hudFrameInterval: 8,
        enemyFarSkipInterval: 5,
        enemyAnimInterval: 4,
        cameraIdleInterval: 4,
      },
    };
  }

  if (effectiveFps < 62) {
    return {
      shadowsEnabled: false,
      environmentEnabled: false,
      pixelRatioCap: 0.72,
      tuning: {
        shadowFrameInterval: 8,
        minimapFrameInterval: 12,
        pickupFrameInterval: 6,
        hudFrameInterval: 6,
        enemyFarSkipInterval: 4,
        enemyAnimInterval: 3,
        cameraIdleInterval: 3,
      },
    };
  }

  if (effectiveFps < 78) {
    return {
      shadowsEnabled: true,
      environmentEnabled: true,
      pixelRatioCap: 0.82,
      tuning: {
        shadowFrameInterval: 5,
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
    environmentEnabled: true,
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
let environmentSynced: boolean | null = null;

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

export function syncEnvironmentRendering(
  scene: THREE.Scene,
  enabled: boolean,
  renderer: THREE.WebGLRenderer,
): void {
  if (environmentSynced === enabled) {
    return;
  }
  environmentSynced = enabled;
  if (enabled) {
    ensureSceneEnvironment(scene, renderer);
    setSceneEnvironmentEnabled(scene, true);
    return;
  }
  setSceneEnvironmentEnabled(scene, false);
}
