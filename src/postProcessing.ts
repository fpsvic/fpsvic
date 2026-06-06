import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1.22 },
    contrast: { value: 1.08 },
    vibrance: { value: 0.16 },
    lift: { value: new THREE.Vector3(0.02, 0.025, 0.04) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float contrast;
    uniform float vibrance;
    uniform vec3 lift;
    varying vec2 vUv;

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = tex.rgb + lift;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float sat = saturation + vibrance * (1.0 - smoothstep(0.08, 0.88, luma));
      col = mix(vec3(luma), col, sat);
      col = (col - 0.5) * contrast + 0.5;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), tex.a);
    }
  `,
};

export type PostFxQuality = {
  enabled: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
};

export class FortnitePostPipeline {
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly gradePass: ShaderPass;
  private enabled = true;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    const size = renderer.getSize(new THREE.Vector2());
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.32,
      0.45,
      0.82,
    );
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(ColorGradeShader);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bloomPass.resolution.set(width, height);
  }

  setQuality(quality: PostFxQuality): void {
    this.enabled = quality.enabled;
    this.bloomPass.strength = quality.bloomStrength;
    this.bloomPass.radius = quality.bloomRadius;
    this.bloomPass.threshold = quality.bloomThreshold;
    this.bloomPass.enabled = quality.enabled && quality.bloomStrength > 0.01;
    this.gradePass.enabled = quality.enabled;
  }

  render(): void {
    if (this.enabled) {
      this.composer.render();
      return;
    }
    const renderer = this.composer.renderer as THREE.WebGLRenderer;
    const renderPass = this.composer.passes[0] as RenderPass;
    renderer.render(renderPass.scene, renderPass.camera);
  }
}

export function getPostFxQuality(effectiveFps: number): PostFxQuality {
  if (effectiveFps < 48) {
    return {
      enabled: true,
      bloomStrength: 0.12,
      bloomRadius: 0.35,
      bloomThreshold: 0.9,
    };
  }
  if (effectiveFps < 62) {
    return {
      enabled: true,
      bloomStrength: 0.22,
      bloomRadius: 0.4,
      bloomThreshold: 0.86,
    };
  }
  if (effectiveFps < 78) {
    return {
      enabled: true,
      bloomStrength: 0.28,
      bloomRadius: 0.44,
      bloomThreshold: 0.84,
    };
  }
  return {
    enabled: true,
    bloomStrength: 0.36,
    bloomRadius: 0.48,
    bloomThreshold: 0.8,
  };
}
