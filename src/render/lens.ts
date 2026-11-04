import { Vector3, type Texture } from 'three';

/**
 * Camera model shared by the underwater composite and the effects drawn after
 * it (particles, beams, silt): barrel distortion of the subsea lens and the
 * exposure of the camera (auto exposure + bias). All materials reference the
 * same uniform objects so the values change in one place.
 */
export interface CameraUniforms {
  /** Barrel distortion coefficient k (0 = rectilinear). */
  uDistort: { value: number };
  /** Viewport aspect (w/h). */
  uAspect: { value: number };
  /** Squared aspect-corrected radius of the image corner, (aspect² + 1) / 4. */
  uLensRc2: { value: number };
  /** 1×1 texture holding the adapted log-luminance (R channel). */
  tExposure: { value: Texture | null };
  /** x: auto exposure on (0/1), y: linear bias multiplier, z: metering key (target mean luminance). */
  uExposure: { value: Vector3 };
  /** x: min gain, y: max gain, z: adaptation strength (0 = none, 1 = full). */
  uExpRange: { value: Vector3 };
}

export function createCameraUniforms(): CameraUniforms {
  return {
    uDistort: { value: 0 },
    uAspect: { value: 16 / 9 },
    uLensRc2: { value: 0.25 * ((16 / 9) ** 2 + 1) },
    tExposure: { value: null },
    uExposure: { value: new Vector3(0, 1, 0.05) },
    uExpRange: { value: new Vector3(0.55, 2.2, 0.62) },
  };
}

/**
 * GLSL: `lensSourceUV(uv)` maps an output (distorted) screen uv to the uv of
 * the rectilinear render; `lensForward(ndc)` maps a rectilinear NDC position
 * to where it appears in the distorted image (inverse, by Newton iterations);
 * `cameraExposure()` returns the current linear exposure gain.
 */
export const CAMERA_GLSL = /* glsl */ `
  uniform float uDistort;
  uniform float uAspect;
  uniform float uLensRc2;
  uniform sampler2D tExposure;
  uniform vec3 uExposure;
  uniform vec3 uExpRange;

  vec2 lensSourceUV(vec2 uv) {
    if (uDistort <= 0.0) return uv;
    vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
    float s = (1.0 + uDistort * dot(d, d)) / (1.0 + uDistort * uLensRc2);
    return 0.5 + (uv - 0.5) * s;
  }

  vec2 lensForward(vec2 ndc) {
    if (uDistort <= 0.0) return ndc;
    vec2 d = ndc * 0.5 * vec2(uAspect, 1.0);
    float rs = length(d);
    if (rs < 1e-5) return ndc;
    float R = rs * (1.0 + uDistort * uLensRc2);
    float r = R;
    for (int i = 0; i < 4; i++) {
      float f = r + uDistort * r * r * r - R;
      r -= f / (1.0 + 3.0 * uDistort * r * r);
    }
    return ndc * (r / rs);
  }

  vec4 lensClip(vec4 clip) {
    if (uDistort <= 0.0 || clip.w <= 1e-4) return clip;
    clip.xy = lensForward(clip.xy / clip.w) * clip.w;
    return clip;
  }

  float cameraExposure() {
    float gain = 1.0;
    if (uExposure.x > 0.5) {
      float logL = texture2D(tExposure, vec2(0.5)).r;
      gain = clamp(pow(uExposure.z / exp(logL), uExpRange.z), uExpRange.x, uExpRange.y);
    }
    return gain * uExposure.y;
  }
`;
