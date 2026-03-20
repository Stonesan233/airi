/**
 * Utilities for lazily loading the Cubism 2 runtime (live2d.min.js) and
 * the pixi-live2d-display/cubism2 module.
 *
 * Cubism 2 requires window.Live2D to be defined before the module can be
 * imported. This loader injects the runtime script tag, waits for it, and
 * then dynamically imports the cubism2 plugin.
 *
 * live2d.min.js is a proprietary file from Live2D Inc.  Place your copy at
 * /assets/js/live2d.min.js inside the public directory, or point
 * VITE_LIVE2D_CUBISM2_RUNTIME_URL to a custom URL.
 */

// -- Runtime loading -----------------------------------------------------------

let runtimeLoadPromise: Promise<void> | null = null

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`[Live2D] Failed to load Cubism 2 runtime from: ${src}`))
    document.head.appendChild(script)
  })
}

/**
 * Ensures the Cubism 2 runtime (live2d.min.js) is loaded exactly once.
 * Resolves immediately if window.Live2D is already defined.
 *
 * @param runtimeUrl URL to live2d.min.js. Defaults to /assets/js/live2d.min.js.
 */
export function loadCubism2Runtime(
  runtimeUrl = (import.meta.env.VITE_LIVE2D_CUBISM2_RUNTIME_URL as string | undefined)
    ?? '/assets/js/live2d.min.js',
): Promise<void> {
  // Already available
  if ((window as any).Live2D)
    return Promise.resolve()

  // Deduplicate concurrent calls
  if (runtimeLoadPromise)
    return runtimeLoadPromise

  runtimeLoadPromise = injectScript(runtimeUrl).catch((err) => {
    runtimeLoadPromise = null
    throw err
  })

  return runtimeLoadPromise
}

// -- Lazy cubism2 module -------------------------------------------------------

type Cubism2Module = typeof import('pixi-live2d-display/cubism2')

let cubism2ModulePromise: Promise<Cubism2Module> | null = null

/**
 * Loads the Cubism 2 runtime and dynamically imports pixi-live2d-display/cubism2.
 * Safe to call multiple times – the module is only imported once.
 */
export async function importCubism2(runtimeUrl?: string): Promise<Cubism2Module> {
  if (!cubism2ModulePromise) {
    cubism2ModulePromise = loadCubism2Runtime(runtimeUrl)
      .then(async () => {
        // Cubism 2 runtime may need init() called — try if available
        const Live2D = (window as any).Live2D
        if (Live2D && typeof Live2D.init === 'function') {
          console.debug('[Live2D] Calling Live2D.init()')
          Live2D.init()
        }
        return import('pixi-live2d-display/cubism2')
      })
      .catch((err) => {
        cubism2ModulePromise = null
        throw err
      })
  }
  return cubism2ModulePromise
}
