/**
 * Parameter ID mapping from Cubism 4 standard names to the common Cubism 2
 * naming convention used in BanG Dream and similar titles.
 *
 * Cubism 2 parameter IDs are embedded in the .moc file and are model-specific,
 * but this covers the de-facto standard convention used widely.
 */
export const CUBISM4_TO_CUBISM2_PARAM_IDS: Record<string, string> = {
  ParamAngleX: 'PARAM_ANGLE_X',
  ParamAngleY: 'PARAM_ANGLE_Y',
  ParamAngleZ: 'PARAM_ANGLE_Z',
  ParamEyeLOpen: 'PARAM_EYE_L_OPEN',
  ParamEyeROpen: 'PARAM_EYE_R_OPEN',
  ParamEyeSmile: 'PARAM_EYE_L_SMILE',
  ParamEyeBallX: 'PARAM_EYE_BALL_X',
  ParamEyeBallY: 'PARAM_EYE_BALL_Y',
  ParamMouthOpenY: 'PARAM_MOUTH_OPEN_Y',
  ParamMouthForm: 'PARAM_MOUTH_FORM_01',
  ParamCheek: 'PARAM_CHEEK',
  ParamBodyAngleX: 'PARAM_BODY_ANGLE_X',
  ParamBodyAngleY: 'PARAM_BODY_ANGLE_Y',
  ParamBodyAngleZ: 'PARAM_BODY_ANGLE_Z',
  ParamBreath: 'PARAM_BREATH',
  ParamBrowLX: 'PARAM_BROW_L_X',
  ParamBrowRX: 'PARAM_BROW_R_X',
  ParamBrowLY: 'PARAM_BROW_L_Y',
  ParamBrowRY: 'PARAM_BROW_R_Y',
  ParamBrowLAngle: 'PARAM_BROW_L_ANGLE',
  ParamBrowRAngle: 'PARAM_BROW_R_ANGLE',
  ParamBrowLForm: 'PARAM_BROW_L_FORM',
  ParamBrowRForm: 'PARAM_BROW_R_FORM',
}

/**
 * Resolve a parameter ID for the given Cubism version.
 * For Cubism 2, translates from Cubism 4 standard names to the common Cubism 2 convention.
 * Returns the original ID unchanged for Cubism 4, or for IDs with no known mapping.
 */
export function resolveParamId(cubism4Id: string, version: 'cubism2' | 'cubism4'): string {
  if (version === 'cubism4')
    return cubism4Id
  return CUBISM4_TO_CUBISM2_PARAM_IDS[cubism4Id] ?? cubism4Id
}
