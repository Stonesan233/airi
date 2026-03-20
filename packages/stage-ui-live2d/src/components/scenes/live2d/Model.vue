<script setup lang="ts">
import type { Application } from '@pixi/app'
import type { Live2DModel } from 'pixi-live2d-display/cubism4'

import type { PixiLive2DInternalModel } from '../../../composables/live2d'

import JSZip from 'jszip'

import { listenBeatSyncBeatSignal } from '@proj-airi/stage-shared/beat-sync'
import { useTheme } from '@proj-airi/ui'
import { breakpointsTailwind, until, useBreakpoints } from '@vueuse/core'
import { animate } from 'animejs'
import { formatHex } from 'culori'
import { Mutex } from 'es-toolkit'
import { storeToRefs } from 'pinia'
import { DropShadowFilter } from 'pixi-filters'
import { Live2DFactory as Cubism4Factory, Live2DModel as Cubism4Model, MotionPriority } from 'pixi-live2d-display/cubism4'
import { computed, onMounted, onUnmounted, ref, shallowRef, toRef, watch } from 'vue'

import {
  createBeatSyncController,

  useLive2DMotionManagerUpdate,
  useMotionUpdatePluginAutoEyeBlink,
  useMotionUpdatePluginBeatSync,
  useMotionUpdatePluginIdleDisable,
  useMotionUpdatePluginIdleFocus,
} from '../../../composables/live2d'
import { Emotion, EmotionNeutralMotionName } from '../../../constants/emotions'
import { useLive2d } from '../../../stores/live2d'
import { resolveParamId } from '../../../utils/cubism2-param-ids'
import { importCubism2 } from '../../../utils/live2d-cubism2-runtime'
import { loadCubism2FilesFromZip } from '../../../utils/live2d-zip-loader'

const props = withDefaults(defineProps<{
  modelSrc?: string
  modelId?: string

  app?: Application
  mouthOpenSize?: number
  width: number
  height: number
  paused?: boolean
  focusAt?: { x: number, y: number }
  disableFocusAt?: boolean
  xOffset?: number | string
  yOffset?: number | string
  scale?: number
  themeColorsHue?: number
  themeColorsHueDynamic?: boolean
  live2dIdleAnimationEnabled?: boolean
  live2dAutoBlinkEnabled?: boolean
  live2dForceAutoBlinkEnabled?: boolean
  live2dShadowEnabled?: boolean
}>(), {
  mouthOpenSize: 0,
  paused: false,
  focusAt: () => ({ x: 0, y: 0 }),
  disableFocusAt: false,
  scale: 1,
  themeColorsHue: 220.44,
  themeColorsHueDynamic: false,
  live2dIdleAnimationEnabled: true,
  live2dAutoBlinkEnabled: true,
  live2dForceAutoBlinkEnabled: false,
  live2dShadowEnabled: true,
})

const emits = defineEmits<{
  (e: 'modelLoaded'): void
  (e: 'error', error: Error): void
}>()

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })

function parsePropsOffset() {
  let xOffset = Number.parseFloat(String(props.xOffset)) || 0
  let yOffset = Number.parseFloat(String(props.yOffset)) || 0

  if (String(props.xOffset).endsWith('%')) {
    xOffset = (Number.parseFloat(String(props.xOffset).replace('%', '')) / 100) * props.width
  }
  if (String(props.yOffset).endsWith('%')) {
    yOffset = (Number.parseFloat(String(props.yOffset).replace('%', '')) / 100) * props.height
  }

  return {
    xOffset,
    yOffset,
  }
}

const modelSrcRef = toRef(() => props.modelSrc)

const modelLoading = ref(false)
// NOTICE: boolean is sufficient; this flag is only used inside loadModel to bail out if the component unmounts mid-load.
let isUnmounted = false

const modelLoadMutex = new Mutex()

/**
 * Detect cubism version from model source.
 * Cubism2: .moc file, model.json
 * Cubism4: .moc3 file, model3.json
 *
 * For ZIP or blob URLs the URL itself carries no version hint, so we peek
 * inside the archive and check for a bare `.moc` file (Cubism 2 marker).
 */
async function detectCubismVersion(modelSrc: string): Promise<'cubism2' | 'cubism4'> {
  const src = modelSrc.toLowerCase()
  // Direct file references are unambiguous
  if (src.includes('.moc') && !src.includes('.moc3'))
    return 'cubism2'
  if (src.includes('model.json') && !src.includes('model3.json'))
    return 'cubism2'

  // For ZIP files or blob URLs, peek inside the archive
  if (src.endsWith('.zip') || src.startsWith('blob:')) {
    try {
      const res = await fetch(modelSrc)
      const blob = await res.blob()
      const zip = await JSZip.loadAsync(blob)
      const paths = Object.keys(zip.files)
      const hasMoc2 = paths.some(p => p.endsWith('.moc') && !p.endsWith('.moc3'))
      return hasMoc2 ? 'cubism2' : 'cubism4'
    }
    catch {
      // Fall through to default on any fetch/parse error
    }
  }

  return 'cubism4'
}

const offset = computed(() => parsePropsOffset())

const pixiApp = toRef(() => props.app)
const paused = toRef(() => props.paused)
const focusAt = toRef(() => props.focusAt)
const model = ref<Live2DModel<PixiLive2DInternalModel>>()
const modelVersion = ref<'cubism2' | 'cubism4'>('cubism4')
const initialModelWidth = ref<number>(0)
const initialModelHeight = ref<number>(0)
const mouthOpenSize = computed(() => Math.max(0, Math.min(100, props.mouthOpenSize)))
const lastUpdateTime = ref(0)

const { isDark: dark } = useTheme()
const breakpoints = useBreakpoints(breakpointsTailwind)
const isMobile = computed(() => breakpoints.between('sm', 'md').value || breakpoints.smaller('sm').value)
const dropShadowFilter = shallowRef(new DropShadowFilter({
  alpha: 0.2,
  blur: 0,
  distance: 20,
  rotation: 45,
}))

function setParam(paramId: string, value: number) {
  if (!model.value)
    return
  const coreModel = model.value.internalModel.coreModel as any
  const resolvedId = resolveParamId(paramId, modelVersion.value)
  // NOTICE: Cubism 2 core model (Live2DModelWebGL) uses setParamFloat();
  // Cubism 4 uses setParameterValueById(). The APIs are not interchangeable.
  if (modelVersion.value === 'cubism2')
    coreModel.setParamFloat(resolvedId, value)
  else
    coreModel.setParameterValueById(resolvedId, value)
}

let resizeAnimation: ReturnType<typeof animate> | undefined

function computeScaleAndPosition() {
  let offsetFactor = 2.2
  if (isMobile.value) {
    offsetFactor = 2.2
  }

  const heightScale = (props.height * 0.95 / initialModelHeight.value * offsetFactor)
  const widthScale = (props.width * 0.95 / initialModelWidth.value * offsetFactor)
  let scale = Math.min(heightScale, widthScale)

  if (Number.isNaN(scale) || scale <= 0) {
    scale = 1e-6
  }

  return {
    scale: scale * props.scale,
    x: (props.width / 2) + offset.value.xOffset,
    y: props.height + offset.value.yOffset,
  }
}

function setScaleAndPosition(animated = false) {
  if (!model.value)
    return

  const target = computeScaleAndPosition()

  if (!animated) {
    model.value.scale.set(target.scale, target.scale)
    model.value.x = target.x
    model.value.y = target.y
    return
  }

  resizeAnimation?.pause()

  const current = {
    scale: model.value.scale.x,
    x: model.value.x,
    y: model.value.y,
  }

  resizeAnimation = animate(current, {
    scale: target.scale,
    x: target.x,
    y: target.y,
    duration: 200,
    ease: 'outQuad',
    onUpdate: () => {
      if (!model.value)
        return
      model.value.scale.set(current.scale, current.scale)
      model.value.x = current.x
      model.value.y = current.y
    },
  })
}

const live2dStore = useLive2d()
const {
  currentMotion,
  availableMotions,
  motionMap,
  modelParameters,
} = storeToRefs(live2dStore)

const themeColorsHue = toRef(() => props.themeColorsHue)
const themeColorsHueDynamic = toRef(() => props.themeColorsHueDynamic)
const live2dIdleAnimationEnabled = toRef(() => props.live2dIdleAnimationEnabled)
const live2dAutoBlinkEnabled = toRef(() => props.live2dAutoBlinkEnabled)
const live2dForceAutoBlinkEnabled = toRef(() => props.live2dForceAutoBlinkEnabled)
const live2dShadowEnabled = toRef(() => props.live2dShadowEnabled)

const localCurrentMotion = ref<{ group: string, index: number }>({ group: 'Idle', index: 0 })
const beatSync = createBeatSyncController({
  baseAngles: () => ({
    x: modelParameters.value.angleX,
    y: modelParameters.value.angleY,
    z: modelParameters.value.angleZ,
  }),
  initialStyle: 'sway-sine',
})

// Listen for model reload requests (e.g., when runtime motion is uploaded)
const disposeShouldUpdateView = live2dStore.onShouldUpdateView(() => {
  loadModel()
})

async function loadModel() {
  await until(modelLoading).not.toBeTruthy()

  await modelLoadMutex.acquire()

  modelLoading.value = true
  componentState.value = 'loading'

  if (!pixiApp.value || !pixiApp.value.stage) {
    try {
      // NOTICE: shouldUpdateView can fire while the canvas (pixiApp) is being torn down/recreated.
      // Wait briefly for the new stage instead of bailing out, otherwise we keep a blank screen.
      await until(() => !!pixiApp.value && !!pixiApp.value.stage).toBeTruthy({ timeout: 1500 })
    }
    catch {
      modelLoading.value = false
      componentState.value = 'mounted'
      return
    }
  }

  // REVIEW: here as await until(...) guarded the pixiApp and stage to be valid.
  if (model.value && pixiApp.value?.stage) {
    try {
      pixiApp.value.stage.removeChild(model.value)
      model.value.destroy()
    }
    catch (error) {
      console.warn('Error removing old model:', error)
    }
    model.value = undefined
  }
  if (!modelSrcRef.value) {
    console.warn('No Live2D model source provided.')
    modelLoading.value = false
    componentState.value = 'mounted'
    return
  }

  try {
    if (isUnmounted) {
      modelLoading.value = false
      componentState.value = 'mounted'
      return
    }

    // Detect cubism version and use appropriate factory
    const version = await detectCubismVersion(modelSrcRef.value)
    console.info('[Live2D] Detected model version:', version)
    modelVersion.value = version

    let Factory: typeof Cubism4Factory
    let live2DModel: Live2DModel<PixiLive2DInternalModel>

    if (version === 'cubism2') {
      const cubism2 = await importCubism2()
      // Ticker is already registered in Canvas.vue at init time
      Factory = cubism2.Live2DFactory as unknown as typeof Cubism4Factory
      live2DModel = new cubism2.Live2DModel() as unknown as Live2DModel<PixiLive2DInternalModel>
    }
    else {
      Factory = Cubism4Factory
      live2DModel = new Cubism4Model<PixiLive2DInternalModel>()
    }

    // NOTICE: For Cubism 2 ZIP/blob sources we pre-extract the archive and attach
    // a Cubism2ModelSettings object to the File array so that FileLoader uses it
    // directly, bypassing ZipLoader.createSettings which calls Live2DFactory.findRuntime
    // and fails with "Unknown settings JSON" due to runtime registration timing issues
    // in pixi-live2d-display v0.4.x.
    const src = modelSrcRef.value.toLowerCase()
    const isZipSource = src.endsWith('.zip') || src.startsWith('blob:')
    let modelSource: any = { url: modelSrcRef.value, id: props.modelId }

    if (version === 'cubism2' && isZipSource) {
      const response = await fetch(modelSrcRef.value)
      const blob = await response.blob()
      modelSource = await loadCubism2FilesFromZip(blob)
    }

    await Factory.setupLive2DModel(live2DModel, modelSource, { autoInteract: false })
    availableMotions.value.forEach((motion) => {
      if (motion.motionName in Emotion) {
        motionMap.value[motion.fileName] = motion.motionName
      }
      else {
        motionMap.value[motion.fileName] = EmotionNeutralMotionName
      }
    })

    // --- Scene

    model.value = live2DModel
    // REVIEW: pixiApp and stage are guaranteed to be valid here due to the until(...) above.
    pixiApp.value!.stage.addChild(model.value)
    initialModelWidth.value = model.value.width
    initialModelHeight.value = model.value.height
    console.info(`[Live2D] Model loaded: width=${initialModelWidth.value}, height=${initialModelHeight.value}, version=${version}`)
    model.value.anchor.set(0.5, 0.5)
    setScaleAndPosition()

    console.info(`[Live2D] After setScaleAndPosition: scale=${model.value.scale.x}, x=${model.value.x}, y=${model.value.y}`)

    // --- Cubism2-specific rendering fix
    // NOTICE: Cubism2 models (especially large 2000x2500) need different positioning
    // and potentially texture flip compared to Cubism4.
    if (version === 'cubism2') {
      const app = pixiApp.value!
      const stageW = app.screen.width
      const stageH = app.screen.height

      // Calculate scale to fit the large model in stage
      const scale = Math.min(stageW / initialModelWidth.value * 0.85, stageH / initialModelHeight.value * 0.85)
      console.info(`[Live2D] Cubism2 fix: stage=${stageW}x${stageH}, calculated scale=${scale}`)

      // Set anchor to bottom-center (feet alignment) instead of center
      model.value.anchor.set(0.5, 0.85)
      // Position at bottom-center of stage
      model.value.position.set(stageW * 0.5, stageH * 0.9)
      model.value.scale.set(scale)

      console.info(`[Live2D] Cubism2 after fix: anchor=${model.value.anchor.x},${model.value.anchor.y}, pos=${model.value.x},${model.value.y}, scale=${model.value.scale.x}`)

      // Try to fix texture flip if needed
      const internalModel = model.value.internalModel as any
      if (internalModel) {
        // Check if textureFlipY exists and try both values
        console.info(`[Live2D] Cubism2 internal model:`, {
          constructorName: internalModel.constructor?.name,
          hasTextureFlipY: 'textureFlipY' in internalModel,
        })
      }
    }

    // --- Interaction

    model.value.on('hit', (hitAreas: string[]) => {
      if (model.value && hitAreas.includes('body'))
        model.value.motion('tap_body')
    })

    // --- Motion

    const internalModel = model.value.internalModel as PixiLive2DInternalModel
    const motionManager = internalModel.motionManager
    setParam('ParamMouthOpenY', mouthOpenSize.value)

    if (!motionManager) {
      console.warn('[Live2D] Motion manager not available for this model, some features will be skipped')
    }

    if (motionManager) {
      availableMotions.value = Object
        .entries(motionManager.definitions)
        .flatMap(([motionName, definition]) => (definition?.map((motion: any, index: number) => ({
          motionName,
          motionIndex: index,
          // NOTICE: Cubism 4 uses "File" (capital F), Cubism 2 uses "file" (lowercase)
          fileName: motion.File ?? motion.file,
        })) || []))
        .filter(Boolean)
    }

    // Check if user has selected a runtime motion to play as idle
    const selectedMotionGroup = localStorage.getItem('selected-runtime-motion-group')
    const selectedMotionIndex = localStorage.getItem('selected-runtime-motion-index')

    // Configure the selected motion to loop (Cubism 4 only, uses motionGroups internal structure)
    if (version === 'cubism4' && motionManager && selectedMotionGroup !== null && selectedMotionIndex) {
      const groupIndex = (motionManager.groups as Record<string, any>)[selectedMotionGroup]
      if (groupIndex !== undefined && motionManager.motionGroups[groupIndex]) {
        const motionIndex = Number.parseInt(selectedMotionIndex)
        const motion = motionManager.motionGroups[groupIndex][motionIndex]
        if (motion && motion._looper) {
          // Force the motion to loop
          motion._looper.loopDuration = 0 // 0 means infinite loop
          console.info('Configured motion to loop infinitely:', selectedMotionGroup, motionIndex)
        }
      }
    }

    if (selectedMotionGroup !== null && selectedMotionIndex && live2dIdleAnimationEnabled.value) {
      setTimeout(() => {
        console.info('Playing selected runtime motion:', selectedMotionGroup, selectedMotionIndex)
        currentMotion.value = {
          group: selectedMotionGroup,
          index: Number.parseInt(selectedMotionIndex),
        }
      }, 300)
    }

    // Remove eye ball movements from idle motion group to prevent conflicts
    // This is too hacky
    // FIXME: it cannot blink if loading a model only have idle motion
    // Only apply to cubism4 models
    if (version === 'cubism4' && motionManager?.groups?.idle) {
      motionManager.motionGroups[motionManager.groups.idle]?.forEach((motion) => {
        motion._motionData.curves.forEach((curve: any) => {
        // TODO: After emotion mapper, stage editor, eye related parameters should be take cared to be dynamical instead of hardcoding
          if (curve.id === 'ParamEyeBallX' || curve.id === 'ParamEyeBallY') {
            curve.id = `_${curve.id}`
          }
        })
      })
    }

    // This is hacky too
    // Only apply motion manager updates to cubism4 models
    const motionManagerUpdate = (version === 'cubism4' && motionManager)
      ? useLive2DMotionManagerUpdate({
          internalModel,
          motionManager,
          modelParameters,
          live2dIdleAnimationEnabled,
          live2dAutoBlinkEnabled,
          live2dForceAutoBlinkEnabled,
          lastUpdateTime,
        })
      : null

    // Register motion manager update plugins (cubism4 only)
    if (motionManagerUpdate) {
      motionManagerUpdate.register(useMotionUpdatePluginBeatSync(beatSync), 'pre')
      motionManagerUpdate.register(useMotionUpdatePluginIdleDisable(), 'pre')
      motionManagerUpdate.register(useMotionUpdatePluginIdleFocus(), 'post')
      motionManagerUpdate.register(useMotionUpdatePluginAutoEyeBlink(), 'post')

      const hookedUpdate = motionManager.update as (model: PixiLive2DInternalModel['coreModel'], now: number) => boolean
      motionManager.update = function (model: PixiLive2DInternalModel['coreModel'], now: number) {
        return motionManagerUpdate.hookUpdate(model, now, hookedUpdate)
      }
    }

    if (motionManager) {
      motionManager.on('motionStart', (group, index) => {
        localCurrentMotion.value = { group, index }
      })
    }

    // Listen for motion finish to restart runtime motion for looping
    if (motionManager) {
      motionManager.on('motionFinish', () => {
        const selectedMotionGroup = localStorage.getItem('selected-runtime-motion-group')
        const selectedMotionIndex = localStorage.getItem('selected-runtime-motion-index')

        if (selectedMotionGroup !== null && selectedMotionIndex && live2dIdleAnimationEnabled.value) {
          // Restart the selected runtime motion immediately for seamless looping
          console.info('Motion finished, restarting runtime motion:', selectedMotionGroup, selectedMotionIndex)
          // Use requestAnimationFrame to restart on the next frame for smooth transition
          requestAnimationFrame(() => {
            currentMotion.value = {
              group: selectedMotionGroup,
              index: Number.parseInt(selectedMotionIndex),
            }
          })
        }
      })
    }

    // Apply all stored parameters to the model
    setParam('ParamAngleX', modelParameters.value.angleX)
    setParam('ParamAngleY', modelParameters.value.angleY)
    setParam('ParamAngleZ', modelParameters.value.angleZ)
    setParam('ParamEyeLOpen', modelParameters.value.leftEyeOpen)
    setParam('ParamEyeROpen', modelParameters.value.rightEyeOpen)
    setParam('ParamEyeSmile', modelParameters.value.leftEyeSmile)
    setParam('ParamBrowLX', modelParameters.value.leftEyebrowLR)
    setParam('ParamBrowRX', modelParameters.value.rightEyebrowLR)
    setParam('ParamBrowLY', modelParameters.value.leftEyebrowY)
    setParam('ParamBrowRY', modelParameters.value.rightEyebrowY)
    setParam('ParamBrowLAngle', modelParameters.value.leftEyebrowAngle)
    setParam('ParamBrowRAngle', modelParameters.value.rightEyebrowAngle)
    setParam('ParamBrowLForm', modelParameters.value.leftEyebrowForm)
    setParam('ParamBrowRForm', modelParameters.value.rightEyebrowForm)
    setParam('ParamMouthOpenY', modelParameters.value.mouthOpen)
    setParam('ParamMouthForm', modelParameters.value.mouthForm)
    setParam('ParamCheek', modelParameters.value.cheek)
    setParam('ParamBodyAngleX', modelParameters.value.bodyAngleX)
    setParam('ParamBodyAngleY', modelParameters.value.bodyAngleY)
    setParam('ParamBodyAngleZ', modelParameters.value.bodyAngleZ)
    setParam('ParamBreath', modelParameters.value.breath)

    emits('modelLoaded')
  }
  catch (error) {
    console.error('[Live2D] Failed to load model:', error)
    emits('error', error instanceof Error ? error : new Error(String(error)))
  }
  finally {
    modelLoading.value = false
    componentState.value = 'mounted'
    modelLoadMutex.release()
  }
}

async function setMotion(motionName: string, index?: number) {
  // TODO: motion? Not every Live2D model has motion, we do need to help users to set motion
  if (!model.value) {
    console.warn('Cannot set motion: model not loaded')
    return
  }

  console.info('Setting motion:', motionName, 'index:', index)
  try {
    if (modelVersion.value === 'cubism2') {
      // Cubism2 does not support MotionPriority
      await model.value.motion(motionName, index)
    }
    else {
      await model.value.motion(motionName, index, MotionPriority.FORCE)
    }
    console.info('Motion started successfully:', motionName)
  }
  catch (error) {
    console.error('Failed to start motion:', motionName, error)
  }
}

function handleResize() {
  setScaleAndPosition(true)
}

const dropShadowColorComputer = ref<HTMLDivElement>()
const dropShadowAnimationId = ref(0)

function updateDropShadowFilter() {
  if (!model.value)
    return

  if (!live2dShadowEnabled.value) {
    model.value.filters = []
    return
  }

  if (!dropShadowColorComputer.value)
    return

  const color = getComputedStyle(dropShadowColorComputer.value).backgroundColor
  dropShadowFilter.value.color = Number(formatHex(color)!.replace('#', '0x'))
  model.value.filters = [dropShadowFilter.value]
}

watch([() => props.width, () => props.height], handleResize)
watch(modelSrcRef, async () => await loadModel(), { immediate: true })
watch(dark, updateDropShadowFilter, { immediate: true })
watch([model, themeColorsHue], updateDropShadowFilter)
watch(live2dShadowEnabled, updateDropShadowFilter)
watch(offset, () => setScaleAndPosition())
watch(() => props.scale, () => setScaleAndPosition())

// TODO: This is hacky!
function updateDropShadowFilterLoop() {
  updateDropShadowFilter()
  if (!live2dShadowEnabled.value) {
    dropShadowAnimationId.value = 0
    return
  }

  dropShadowAnimationId.value = requestAnimationFrame(updateDropShadowFilterLoop)
}

watch([themeColorsHueDynamic, live2dShadowEnabled], ([dynamic, shadowEnabled]) => {
  if (dynamic && shadowEnabled) {
    dropShadowAnimationId.value = requestAnimationFrame(updateDropShadowFilterLoop)
  }
  else {
    cancelAnimationFrame(dropShadowAnimationId.value)
    dropShadowAnimationId.value = 0
  }
}, { immediate: true })

watch(mouthOpenSize, value => setParam('ParamMouthOpenY', value))
watch(currentMotion, value => setMotion(value.group, value.index))
watch(paused, value => value ? pixiApp.value?.stop() : pixiApp.value?.start())

// Watch and apply model parameters
watch(() => modelParameters.value.angleX, value => setParam('ParamAngleX', value))
watch(() => modelParameters.value.angleY, value => setParam('ParamAngleY', value))
watch(() => modelParameters.value.angleZ, value => setParam('ParamAngleZ', value))
watch(() => modelParameters.value.leftEyeOpen, value => setParam('ParamEyeLOpen', value))
watch(() => modelParameters.value.rightEyeOpen, value => setParam('ParamEyeROpen', value))
watch(() => modelParameters.value.mouthOpen, value => setParam('ParamMouthOpenY', value))
watch(() => modelParameters.value.mouthForm, value => setParam('ParamMouthForm', value))
watch(() => modelParameters.value.cheek, value => setParam('ParamCheek', value))
watch(() => modelParameters.value.bodyAngleX, value => setParam('ParamBodyAngleX', value))
watch(() => modelParameters.value.bodyAngleY, value => setParam('ParamBodyAngleY', value))
watch(() => modelParameters.value.bodyAngleZ, value => setParam('ParamBodyAngleZ', value))
watch(() => modelParameters.value.breath, value => setParam('ParamBreath', value))

// Watch eyebrow parameters
watch(() => modelParameters.value.leftEyebrowLR, value => setParam('ParamBrowLX', value))
watch(() => modelParameters.value.rightEyebrowLR, value => setParam('ParamBrowRX', value))
watch(() => modelParameters.value.leftEyebrowY, value => setParam('ParamBrowLY', value))
watch(() => modelParameters.value.rightEyebrowY, value => setParam('ParamBrowRY', value))
watch(() => modelParameters.value.leftEyebrowAngle, value => setParam('ParamBrowLAngle', value))
watch(() => modelParameters.value.rightEyebrowAngle, value => setParam('ParamBrowRAngle', value))
watch(() => modelParameters.value.leftEyebrowForm, value => setParam('ParamBrowLForm', value))
watch(() => modelParameters.value.rightEyebrowForm, value => setParam('ParamBrowRForm', value))

// Watch for idle animation setting changes and stop motions if disabled
watch(live2dIdleAnimationEnabled, (enabled) => {
  if (!enabled && model.value) {
    const internalModel = model.value.internalModel
    if (internalModel?.motionManager) {
      internalModel.motionManager.stopAllMotions()
    }
  }
})

watch(focusAt, (value) => {
  if (!model.value)
    return
  if (props.disableFocusAt)
    return

  model.value.focus(value.x, value.y)
})

onMounted(() => {
  const removeListener = listenBeatSyncBeatSignal(() => beatSync.scheduleBeat())
  onUnmounted(() => removeListener())
})

onMounted(async () => {
  updateDropShadowFilter()
})

onUnmounted(() => {
  isUnmounted = true
  resizeAnimation?.pause()
  disposeShouldUpdateView?.()
})

function listMotionGroups() {
  return availableMotions.value
}

defineExpose({
  setMotion,
  listMotionGroups,
})

import.meta.hot?.dispose(() => {
  console.warn('[Dev] Reload on HMR dispose is active for this component. Performing a full reload.')
  window.location.reload()
})
</script>

<template>
  <div ref="dropShadowColorComputer" hidden bg="primary-400 dark:primary-500" />
  <slot />
</template>
