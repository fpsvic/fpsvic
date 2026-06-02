import * as THREE from "three";
import type { TerrainTextureSet } from "./terrainTextures";

const TERRAIN_UV_SCALE = 0.072;

export function createTerrainSplatMaterial(textures: TerrainTextureSet): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 0.02,
    envMapIntensity: 0.88,
    normalMap: textures.grass.normal,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughnessMap: textures.grass.roughness,
    aoMap: textures.grass.ao,
    aoMapIntensity: 1,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.grassMap = { value: textures.grass.color };
    shader.uniforms.dirtMap = { value: textures.dirt.color };
    shader.uniforms.rockMap = { value: textures.rock.color };
    shader.uniforms.grassNormal = { value: textures.grass.normal };
    shader.uniforms.dirtNormal = { value: textures.dirt.normal };
    shader.uniforms.rockNormal = { value: textures.rock.normal };
    shader.uniforms.grassRough = { value: textures.grass.roughness };
    shader.uniforms.dirtRough = { value: textures.dirt.roughness };
    shader.uniforms.rockRough = { value: textures.rock.roughness };
    shader.uniforms.grassAo = { value: textures.grass.ao };
    shader.uniforms.dirtAo = { value: textures.dirt.ao };
    shader.uniforms.rockAo = { value: textures.rock.ao };
    shader.uniforms.terrainUvScale = { value: TERRAIN_UV_SCALE };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vTerrainWorldPos;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
vTerrainWorldPos = worldPosition.xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D grassMap;
uniform sampler2D dirtMap;
uniform sampler2D rockMap;
uniform sampler2D grassNormal;
uniform sampler2D dirtNormal;
uniform sampler2D rockNormal;
uniform sampler2D grassRough;
uniform sampler2D dirtRough;
uniform sampler2D rockRough;
uniform sampler2D grassAo;
uniform sampler2D dirtAo;
uniform sampler2D rockAo;
uniform float terrainUvScale;
varying vec3 vTerrainWorldPos;

vec3 sampleTerrainNormal( sampler2D tex, vec2 uv ) {
  return texture2D( tex, uv ).xyz * 2.0 - 1.0;
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
#ifdef USE_COLOR
  vec2 terrainUv = vTerrainWorldPos.xz * terrainUvScale;
  vec2 dirtUv = terrainUv * 1.04 + vec2( 0.17, 0.23 );
  vec2 rockUv = terrainUv * 0.91 + vec2( 0.41, 0.29 );

  vec3 albedoGrass = texture2D( grassMap, terrainUv ).rgb;
  vec3 albedoDirt = texture2D( dirtMap, dirtUv ).rgb;
  vec3 albedoRock = texture2D( rockMap, rockUv ).rgb;

  float wSum = max( vColor.r + vColor.g + vColor.b, 1e-4 );
  vec3 splatAlbedo = ( albedoGrass * vColor.r + albedoDirt * vColor.g + albedoRock * vColor.b ) / wSum;
  diffuseColor.rgb = splatAlbedo;

  float roughGrass = texture2D( grassRough, terrainUv ).r;
  float roughDirt = texture2D( dirtRough, dirtUv ).r;
  float roughRock = texture2D( rockRough, rockUv ).r;
  roughnessFactor = clamp( ( roughGrass * vColor.r + roughDirt * vColor.g + roughRock * vColor.b ) / wSum, 0.45, 1.0 );

  float aoGrass = texture2D( grassAo, terrainUv ).r;
  float aoDirt = texture2D( dirtAo, dirtUv ).r;
  float aoRock = texture2D( rockAo, rockUv ).r;
  float splatAo = ( aoGrass * vColor.r + aoDirt * vColor.g + aoRock * vColor.b ) / wSum;
  diffuseColor.rgb *= mix( 1.0, splatAo, 0.85 );
#endif`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
#ifdef USE_COLOR
  vec2 terrainUv = vTerrainWorldPos.xz * terrainUvScale;
  vec2 dirtUv = terrainUv * 1.04 + vec2( 0.17, 0.23 );
  vec2 rockUv = terrainUv * 0.91 + vec2( 0.41, 0.29 );

  vec3 nGrass = sampleTerrainNormal( grassNormal, terrainUv );
  vec3 nDirt = sampleTerrainNormal( dirtNormal, dirtUv );
  vec3 nRock = sampleTerrainNormal( rockNormal, rockUv );
  float wSum = max( vColor.r + vColor.g + vColor.b, 1e-4 );
  vec3 mapN = normalize( nGrass * vColor.r + nDirt * vColor.g + nRock * vColor.b );
  normal = perturbNormal2Arb( - vViewPosition, normal, dHdxy_fwd(), mapN.xy, normalScale, faceDirection );
#endif`,
      )
      .replace("#include <map_fragment>", "")
      .replace("#include <roughnessmap_fragment>", "")
      .replace("#include <aomap_fragment>", "");
  };

  material.customProgramCacheKey = () => "terrain_splat_v2";
  return material;
}
