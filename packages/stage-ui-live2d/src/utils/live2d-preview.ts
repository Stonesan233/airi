import cropImg from '@lemonneko/crop-empty-pixels'
import JSZip from 'jszip'

import { Application } from '@pixi/app'
import { extensions } from '@pixi/extensions'
import { Ticker, TickerPlugin } from '@pixi/ticker'
import { Live2DFactory as Cubism4Factory, Live2DModel as Cubism4Model } from 'pixi-live2d-display/cubism4'

import { importCubism2 } from './live2d-cubism2-runtime'

// -- Version detection ---------------------------------------------------------

/**
 * Detect cubism version from a direct model file name (.moc / .model.json).
 */
function detectCubismVersionFromFileName(fileName: string): 'cubism2' | 'cubism4' {
  const name = fileName.toLowerCase()
  if (name.includes('.moc') && !name.includes('.moc3'))
    return 'cubism2'
  if (name.includes('model.json') && !name.includes('model3.json'))
    return 'cubism2'
  return 'cubism4'
}

/**
 * Detect cubism version by peeking inside a ZIP's file list.
 * Needed because the ZIP filename itself carries no version hint.
 */
async function detectCubismVersionFromZip(blob: Blob): Promise<'cubism2' | 'cubism4'> {
  try {
    const zip = await JSZip.loadAsync(blob)
    const paths = Object.keys(zip.files)
    const hasMoc2 = paths.some(p => p.endsWith('.moc') && !p.endsWith('.moc3'))
    return hasMoc2 ? 'cubism2' : 'cubism4'
  }
  catch {
    return 'cubism4'
  }
}

// -- Preview renderer ----------------------------------------------------------

/**
 * Render a Live2D zip/file to an offscreen canvas and return a padded preview data URL.
 */
export async function loadLive2DModelPreview(file: File) {
  const objUrl = URL.createObjectURL(file)
  const res = await fetch(objUrl)
  const blob = await res.blob()

  // Determine cubism version: peek inside ZIP if needed, else use file name
  const isZip = file.name.endsWith('.zip')
  const version = isZip
    ? await detectCubismVersionFromZip(blob)
    : detectCubismVersionFromFileName(file.name)

  // Lazily load Cubism 2 module only when actually needed
  let Factory: typeof Cubism4Factory
  let ModelClass: typeof Cubism4Model

  if (version === 'cubism2') {
    const cubism2 = await importCubism2()
    cubism2.Live2DModel.registerTicker(Ticker)
    Factory = cubism2.Live2DFactory as unknown as typeof Cubism4Factory
    ModelClass = cubism2.Live2DModel as unknown as typeof Cubism4Model
  }
  else {
    Factory = Cubism4Factory
    ModelClass = Cubism4Model
  }

  Cubism4Model.registerTicker(Ticker)
  extensions.add(TickerPlugin)

  const previewWidth = 1440
  const previewHeight = 2560
  const previewResolution = 2

  const offscreenCanvas = document.createElement('canvas')
  offscreenCanvas.width = previewWidth * previewResolution
  offscreenCanvas.height = previewHeight * previewResolution
  offscreenCanvas.style.position = 'absolute'
  offscreenCanvas.style.top = '0'
  offscreenCanvas.style.left = '0'
  offscreenCanvas.style.objectFit = 'cover'
  offscreenCanvas.style.display = 'block'
  offscreenCanvas.style.zIndex = '10000000000'
  offscreenCanvas.style.opacity = '0'
  document.body.appendChild(offscreenCanvas)

  const app = new Application({
    view: offscreenCanvas,
    width: offscreenCanvas.width,
    height: offscreenCanvas.height,
    // Ensure the drawing buffer persists so toDataURL() can read pixels
    preserveDrawingBuffer: true,
    backgroundAlpha: 0,
    autoDensity: false,
    resolution: 1,
    autoStart: false,
  })
  app.stage.scale.set(previewResolution)
  app.ticker.stop()

  const modelInstance = new ModelClass()

  const cleanup = () => {
    app.destroy()
    if (offscreenCanvas.isConnected)
      document.body.removeChild(offscreenCanvas)
    URL.revokeObjectURL(objUrl)
  }

  try {
    await Factory.setupLive2DModel(modelInstance, [new File([blob], file.name)], { autoInteract: false })
    app.stage.addChild(modelInstance)

    modelInstance.x = 275
    modelInstance.y = 450
    modelInstance.width = previewWidth
    modelInstance.height = previewHeight
    modelInstance.scale.set(0.1, 0.1)
    modelInstance.anchor.set(0.5, 0.5)

    await new Promise(resolve => setTimeout(resolve, 500))
    app.renderer.render(app.stage)

    const croppedCanvas = cropImg(offscreenCanvas)

    // padding to 12:16
    const paddingCanvas = document.createElement('canvas')
    paddingCanvas.width = croppedCanvas.width > croppedCanvas.height / 16 * 12 ? croppedCanvas.width : croppedCanvas.height / 16 * 12
    paddingCanvas.height = paddingCanvas.width / 12 * 16
    const paddingCanvasCtx = paddingCanvas.getContext('2d')!

    paddingCanvasCtx.drawImage(croppedCanvas, (paddingCanvas.width - croppedCanvas.width) / 2, (paddingCanvas.height - croppedCanvas.height) / 2, croppedCanvas.width, croppedCanvas.height)
    const paddingDataUrl = paddingCanvas.toDataURL()

    cleanup()

    return paddingDataUrl
  }
  catch (error) {
    console.error(error)
    cleanup()
  }
}
