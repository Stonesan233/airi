import type { ModelSettings } from 'pixi-live2d-display/cubism4'

import JSZip from 'jszip'

import { Cubism2ModelSettings, ZipLoader as Cubism2ZipLoader } from 'pixi-live2d-display/cubism2'
import { Cubism4ModelSettings, ZipLoader as Cubism4ZipLoader } from 'pixi-live2d-display/cubism4'

// Configure both Cubism2 and Cubism4 ZipLoader
Cubism4ZipLoader.zipReader = (data: Blob, _url: string) => JSZip.loadAsync(data)
Cubism2ZipLoader.zipReader = (data: Blob, _url: string) => JSZip.loadAsync(data)

const defaultCreateSettings4 = Cubism4ZipLoader.createSettings
const defaultCreateSettings2 = Cubism2ZipLoader.createSettings

Cubism4ZipLoader.createSettings = async (reader: JSZip) => {
  const filePaths = Object.keys(reader.files)

  // Check if this is a cubism2 model (has .moc but not .moc3)
  const hasMoc2 = filePaths.some(file => isMoc2File(file))
  const hasMoc3 = filePaths.some(file => isMocFile(file))

  if (hasMoc2 && !hasMoc3) {
    // This is a cubism2 model, use cubism2 loader
    return createCubism2Settings(filePaths)
  }

  if (!filePaths.find(file => isSettingsFile(file))) {
    return createFakeSettings(filePaths)
  }

  return defaultCreateSettings4(reader)
}

Cubism2ZipLoader.createSettings = async (reader: JSZip) => {
  const filePaths = Object.keys(reader.files)

  if (!filePaths.find(file => isSettingsFile(file))) {
    return createCubism2Settings(filePaths)
  }

  return defaultCreateSettings2(reader)
}

export function isSettingsFile(file: string) {
  return file.endsWith('.model3.json') || file.endsWith('.model.json')
}

export function isMocFile(file: string) {
  return file.endsWith('.moc3')
}

export function isMoc2File(file: string) {
  // Cubism2 uses .moc (not .moc3)
  return file.endsWith('.moc') && !file.endsWith('.moc3')
}

export function isMotionFile(file: string) {
  // Cubism2: .mtn, Cubism4: .motion3.json
  return file.endsWith('.mtn') || file.endsWith('.motion3.json')
}

export function isExpressionFile(file: string) {
  // Cubism2: .exp, Cubism4: .expression3.json
  return file.endsWith('.exp') || file.endsWith('.expression3.json')
}

export function basename(path: string): string {
  // https://stackoverflow.com/a/15270931
  return path.split(/[\\/]/).pop()!
}

// copy and modified from https://github.com/guansss/live2d-viewer-web/blob/f6060b2ce52c2e26b6b61fa903c837fe343f72d1/src/app/upload.ts#L81-L142
function createFakeSettings(files: string[]): ModelSettings {
  const mocFiles = files.filter(file => isMocFile(file))

  if (mocFiles.length === 0) {
    throw new Error('Expected at least one .moc3 file, got 0')
  }

  // Prefer the shortest-named .moc3 file when multiple are present
  const mocFile = mocFiles.slice().sort((a, b) => basename(a).length - basename(b).length)[0]

  if (mocFiles.length > 1) {
    console.warn(
      `[Live2D] Found ${mocFiles.length} .moc3 files in ZIP, using "${mocFile}". `
      + `Others: ${mocFiles.filter(f => f !== mocFile).map(f => `"${f}"`).join(', ')}`,
    )
  }
  const modelName = basename(mocFile).replace(/\.moc3?/, '')

  const textures = files.filter(f => f.endsWith('.png'))

  if (!textures.length) {
    throw new Error('Textures not found')
  }

  const motions = files.filter(f => isMotionFile(f))
  const physics = files.find(f => f.includes('physics'))
  const pose = files.find(f => f.includes('pose'))

  const settings = new Cubism4ModelSettings({
    url: `${modelName}.model3.json`,
    Version: 3,
    FileReferences: {
      Moc: mocFile,
      Textures: textures,
      Physics: physics,
      Pose: pose,
      Motions: motions.length
        ? {
            '': motions.map(motion => ({ File: motion })),
          }
        : undefined,
    },
  })

  settings.name = modelName;

  // provide this property for FileLoader
  (settings as any)._objectURL = `example://${settings.url}`

  return settings
}

// Create settings for Cubism2 models
function createCubism2Settings(files: string[]): ModelSettings {
  const mocFiles = files.filter(file => isMoc2File(file))

  if (mocFiles.length === 0) {
    throw new Error('Expected at least one .moc file, got 0')
  }

  // When multiple .moc files exist (e.g. base model + event variant), prefer the
  // one whose basename is shortest — event/variant files tend to have longer names
  // with suffixes like "_event050".  Stable sort ensures deterministic selection.
  const mocFile = mocFiles.slice().sort((a, b) => basename(a).length - basename(b).length)[0]

  if (mocFiles.length > 1) {
    console.warn(
      `[Live2D] Found ${mocFiles.length} .moc files in ZIP, using "${mocFile}". `
      + `Others: ${mocFiles.filter(f => f !== mocFile).map(f => `"${f}"`).join(', ')}`,
    )
  }
  const modelName = basename(mocFile).replace(/\.moc$/, '')

  const textures = files.filter(f => f.endsWith('.png'))

  if (!textures.length) {
    throw new Error('Textures not found')
  }

  // Cubism2 uses .mtn for motions
  const motions = files.filter(f => f.endsWith('.mtn'))
  // Cubism2 uses .exp for expressions
  const expressions = files.filter(f => f.endsWith('.exp'))
  const physics = files.find(f => f.includes('physics'))

  const settings = new Cubism2ModelSettings({
    url: `${modelName}.model.json`,
    model: mocFile,
    textures,
    physics,
    motions: motions.length
      ? {
          '': motions.map(motion => ({ file: motion })),
        }
      : undefined,
    expressions: expressions.length
      ? expressions.map(exp => ({
          name: basename(exp).replace('.exp', ''),
          file: exp,
        }))
      : undefined,
  })

  settings.name = modelName;

  // provide this property for FileLoader
  (settings as any)._objectURL = `example://${settings.url}`

  return settings
}

function configureZipLoader(loader: typeof Cubism4ZipLoader | typeof Cubism2ZipLoader) {
  loader.readText = (jsZip: JSZip, path: string) => {
    const file = jsZip.file(path)

    if (!file) {
      throw new Error(`Cannot find file: ${path}`)
    }

    return file.async('text')
  }

  loader.getFilePaths = (jsZip: JSZip) => {
    const paths: string[] = []

    jsZip.forEach(relativePath => paths.push(relativePath))

    return Promise.resolve(paths)
  }

  loader.getFiles = (jsZip: JSZip, paths: string[]) =>
    Promise.all(paths.map(
      async (path) => {
        const fileName = path.slice(path.lastIndexOf('/') + 1)

        const blob = await jsZip.file(path)!.async('blob')

        return new File([blob], fileName)
      },
    ))
}

configureZipLoader(Cubism4ZipLoader)
configureZipLoader(Cubism2ZipLoader)

/**
 * Resolve a relative path against a base path the same way Node's url.resolve does.
 * Used to map model.json-relative file references to their actual ZIP paths.
 */
function zipPathResolve(base: string, relative: string): string {
  // Absolute paths and protocol-relative paths are returned as-is
  if (relative.includes('://') || relative.startsWith('/'))
    return relative
  // Use the browser URL API with a synthetic base so we get proper path joining
  return new URL(relative, `http://x/${base}`).pathname.slice(1)
}

/**
 * Load a Cubism 2 model from a ZIP blob by manually extracting files and creating
 * a ModelSettings object, bypassing ZipLoader.createSettings entirely.
 *
 * Returns a File[] with a `.settings` property attached. When FileLoader.factory
 * receives a File[] with `.settings` already set it uses those settings directly
 * and skips the createSettings call that was throwing "Unknown settings JSON".
 *
 * NOTICE: This is the primary workaround for pixi-live2d-display v0.4.x where
 * ZipLoader.createSettings calls Live2DFactory.findRuntime, but the Cubism 2
 * runtime registration sometimes isn't visible from within the closure when called
 * through the factory pipeline. By pre-extracting and attaching settings we skip
 * that code path completely.
 */
export async function loadCubism2FilesFromZip(blob: Blob): Promise<File[]> {
  const zip = await JSZip.loadAsync(blob)
  // Only real files, not directory entries
  const filePaths = Object.keys(zip.files).filter(p => !zip.files[p].dir)

  // Locate the settings file — prefer `.model.json` suffix, fall back to bare `model.json`
  const settingsFilePath = filePaths.find(p =>
    !p.endsWith('items_pinned_to_model.json')
    && (p.endsWith('.model.json') || p.endsWith('model.json')),
  )

  let settings: Cubism2ModelSettings

  if (settingsFilePath) {
    const settingsText = await zip.file(settingsFilePath)!.async('text')
    const settingsJSON = JSON.parse(settingsText)
    // url is required by ModelSettings for path resolution
    settingsJSON.url = settingsFilePath
    settings = new Cubism2ModelSettings(settingsJSON)
  }
  else {
    // No settings file in ZIP — synthesise one from the file list
    settings = createCubism2Settings(filePaths) as unknown as Cubism2ModelSettings
  }

  // _objectURL is used by FileLoader as the key into its filesMap
  ;(settings as any)._objectURL = `zip://cubism2/${Date.now()}/${settings.url}`

  // Extract every file referenced by the settings
  const definedFiles = settings.getDefinedFiles()
  const files: File[] = (await Promise.all(
    definedFiles.map(async (definedFile) => {
      const actualPath = zipPathResolve(settings.url, definedFile)
      const zipEntry = zip.file(actualPath)
      if (!zipEntry)
        return null
      const fileName = actualPath.slice(actualPath.lastIndexOf('/') + 1)
      const fileBlob = await zipEntry.async('blob')
      const file = new File([fileBlob], fileName)
      // webkitRelativePath must match what FileLoader.upload expects
      Object.defineProperty(file, 'webkitRelativePath', { value: actualPath })
      return file
    }),
  )).filter((f): f is File => f !== null)

  // Attach settings so FileLoader skips its own createSettings call
  ;(files as any).settings = settings
  return files
}

// Re-export ZipLoader as default for backward compatibility
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const ZipLoader = Cubism4ZipLoader
