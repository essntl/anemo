/*
 * The plugin frame's bootstrap (contract §6, the frame side).
 *
 * This script runs first in every plugin frame. The frame document (GET /api/plugin-frame)
 * inlines it, allowed by its hash in the Content-Security-Policy, together with base.css.
 * It has no dependencies and no build step: what you read is what runs.
 *
 * The frame is sandboxed ("allow-scripts" only, an opaque origin) and its CSP blocks every
 * network request, so the plugin's files can't be fetched from here. Instead:
 *
 *   1. This script removes WebRTC (not covered by the CSP), then says hello to Anemo's page.
 *   2. Anemo's page answers with `init`: the plugin, the slot, its context, the theme, the
 *      plugin's files for this UI, and a MessagePort. Everything after that goes over the port.
 *   3. The theme's variables are set on :root, the entry's HTML becomes the page, its styles
 *      become <style> elements and its scripts run in order from `blob:` URLs (the only
 *      scripts the CSP allows besides this one).
 *   4. The plugin talks to Anemo through `window.anemo` (below).
 *
 * The SDK a plugin sees:
 *
 *   const { context, theme, plugin } = await anemo.ready
 *   const { tasks } = await anemo.call('tasks.list', { status: 'todo' })
 *   const stop = anemo.on('context.changed', (ctx) => render(ctx))
 *   anemo.ui.resize(320); anemo.ui.toast('Saved'); anemo.ui.open('task', id)
 *   await anemo.storage.set('layout', { columns: 2 }); await anemo.storage.get('layout')
 *   await anemo.assets.set('sprite', dataUrl); const { dataUrl } = await anemo.assets.get('sprite')
 *   const picked = await anemo.ui.pickFile({ accept: ['image/gif'] })   // after a click
 *   const { viewport, anchors, route } = await anemo.layout.get()
 *   anemo.files.url('sprites/idle.gif')      // a picture of the package, as a data: URL
 *   anemo.on('code.job', ({ jobId, state }) => refresh())   // a code.panel: a job of its project
 *
 * The slots: "object.panel", "page", "settings", "chat.block", "overlay" and "code.panel"
 * (a tab on the Code page; its context is {code: {device, project, jobId}}).
 *
 * An overlay (slot "overlay") is a transparent layer over Anemo's whole window that lets
 * every click through, except inside the rectangles it names with
 * anemo.ui.setHitRegions([...]). So that Anemo's page knows where the pointer is while the
 * frame has it, this script reports the pointer's position over the port (and only that);
 * Anemo's page decides from it, never the plugin's own code.
 *
 * A failed call rejects with an AnemoError: `err.code` is one of the contract's codes
 * (permission_denied, not_found, invalid_params, declined, rate_limited, unavailable,
 * failed, unknown_method; and `timeout` when no answer came) and `err.message` says why.
 */
(function () {
  'use strict'

  // ---- 1. Before any plugin code: no WebRTC ---------------------------------------------
  // The CSP stops fetch, images, fonts, frames and forms from reaching a server, but not a
  // WebRTC connection. Removing the constructors is a speed bump, not a wall (see the
  // security notes in docs/specs/12-plugins.md), which is why read permissions are reviewed.
  var RTC_NAMES = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']
  RTC_NAMES.forEach(function (name) {
    try {
      delete window[name]
    } catch (e) {
      /* not deletable: overwritten below */
    }
    try {
      Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false })
    } catch (e) {
      /* already gone */
    }
  })

  // ---- Before any plugin code: what the pointer reports use ------------------------------
  // An overlay's pointer reports decide when it may take clicks, so they must not be
  // fakeable: the functions they use are taken now, before a plugin could replace them
  // (on MessagePort.prototype, MouseEvent.prototype or Reflect).
  var apply = Reflect.apply
  var portPost = MessagePort.prototype.postMessage
  function getter(proto, name) {
    return Object.getOwnPropertyDescriptor(proto, name).get
  }
  var clientXOf = getter(MouseEvent.prototype, 'clientX')
  var clientYOf = getter(MouseEvent.prototype, 'clientY')
  var relatedTargetOf = getter(MouseEvent.prototype, 'relatedTarget')
  var pointerTypeOf = getter(PointerEvent.prototype, 'pointerType')

  // ---- The SDK ---------------------------------------------------------------------------

  /** An error from a call, with a code from the contract. */
  function AnemoError(code, message) {
    var error = new Error(message || code)
    error.name = 'AnemoError'
    error.code = code
    return error
  }

  // How long a call may wait for its answer. Long enough for the user to read and answer a
  // confirmation (its token is valid for two minutes), short enough that a lost answer ends.
  var CALL_TIMEOUT_MS = 150000

  var port = null
  var nextId = 1
  var pending = {} // id -> { resolve, reject, timer }
  var listeners = {} // event name -> [functions]
  var initData = null
  var pictures = {} // package path -> data: URL (the version's pictures)
  var resolveReady
  var ready = new Promise(function (resolve) {
    resolveReady = resolve
  })

  function onPortMessage(event) {
    var message = event.data
    if (!message || typeof message !== 'object') return
    // An event from Anemo: { event, data }.
    if (typeof message.event === 'string') {
      if (message.event === 'context.changed' && initData) initData.context = message.data
      if (message.event === 'layout.changed' && initData) initData.layout = message.data
      if (message.event === 'theme.changed' && initData) {
        initData.theme = message.data
        applyTheme(message.data)
      }
      ;(listeners[message.event] || []).slice().forEach(function (fn) {
        try {
          fn(message.data)
        } catch (e) {
          console.error(e)
        }
      })
      return
    }
    // The answer to one of our requests: { id, result } or { id, error }.
    var waiting = pending[message.id]
    if (!waiting) return
    delete pending[message.id]
    clearTimeout(waiting.timer)
    if (message.error) waiting.reject(AnemoError(message.error.code || 'failed', message.error.message))
    else waiting.resolve(message.result)
  }

  /** Ask Anemo to do something (contract §6.3). Resolves with the result. */
  function call(method, params) {
    if (typeof method !== 'string') return Promise.reject(AnemoError('invalid_params', 'anemo.call(method, params): the method is a string such as "tasks.list".'))
    // Calls made before init are sent as soon as the port is there.
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = nextId++
        var timer = setTimeout(function () {
          delete pending[id]
          reject(AnemoError('timeout', 'No answer to "' + method + '" within ' + CALL_TIMEOUT_MS / 1000 + ' seconds.'))
        }, CALL_TIMEOUT_MS)
        pending[id] = { resolve: resolve, reject: reject, timer: timer }
        try {
          port.postMessage({ id: id, method: method, params: params === undefined ? {} : params })
        } catch (e) {
          // Not plain JSON (a function, a DOM node…): it can't be sent.
          clearTimeout(timer)
          delete pending[id]
          reject(AnemoError('invalid_params', 'The params of "' + method + '" must be plain JSON: ' + e.message))
        }
      })
    })
  }

  /** Listen for an event from Anemo. Returns a function that stops listening. */
  function on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('anemo.on(event, fn): fn must be a function.')
    ;(listeners[event] = listeners[event] || []).push(fn)
    return function off() {
      listeners[event] = (listeners[event] || []).filter(function (f) {
        return f !== fn
      })
    }
  }

  var anemo = Object.freeze({
    /** Resolves with the init data: { plugin, slot, ui, context, theme, locale, timeZone, preview, layout }. */
    ready: ready,
    call: call,
    on: on,
    ui: Object.freeze({
      resize: function (height) {
        return call('ui.resize', { height: height })
      },
      toast: function (message, tone) {
        return call('ui.toast', { message: String(message), tone: tone })
      },
      open: function (type, id) {
        return call('ui.open', { type: type, id: id })
      },
      setHitRegions: function (regions) {
        return call('ui.setHitRegions', { regions: regions || [] })
      },
      setVisible: function (visible) {
        return call('ui.setVisible', { visible: visible !== false })
      },
      pickFile: function (options) {
        return call('ui.pickFile', options || {})
      },
    }),
    layout: Object.freeze({
      get: function () {
        return call('layout.get', {})
      },
    }),
    assets: Object.freeze({
      get: function (key) {
        return call('assets.get', { key: key })
      },
      set: function (key, dataUrl) {
        return call('assets.set', { key: key, dataUrl: dataUrl })
      },
      delete: function (key) {
        return call('assets.delete', { key: key })
      },
      list: function () {
        return call('assets.list', {})
      },
    }),
    files: Object.freeze({
      /** A picture of the package (a path from its root) as a data: URL, or null. */
      url: function (path) {
        var key = resolvePath('', String(path || ''))
        return Object.prototype.hasOwnProperty.call(pictures, key) ? pictures[key] : null
      },
    }),
    storage: Object.freeze({
      get: function (key) {
        return call('storage.get', { key: key })
      },
      set: function (key, value) {
        return call('storage.set', { key: key, value: value })
      },
      delete: function (key) {
        return call('storage.delete', { key: key })
      },
      list: function (prefix) {
        return call('storage.list', prefix === undefined ? {} : { prefix: prefix })
      },
    }),
  })
  Object.defineProperty(window, 'anemo', { value: anemo, writable: false, configurable: false })

  // ---- 3. Building the page ----------------------------------------------------------------

  /** Anemo's colours, fonts, radii and spacing as CSS variables on :root (see base.css). */
  function applyTheme(theme) {
    if (!theme) return
    var root = document.documentElement
    var vars = theme.vars || {}
    Object.keys(vars).forEach(function (name) {
      if (name.indexOf('--') === 0) root.style.setProperty(name, String(vars[name]))
    })
    root.setAttribute('data-theme', theme.mode === 'dark' ? 'dark' : 'light')
    root.setAttribute('data-density', theme.density === 'compact' ? 'compact' : 'comfortable')
    // The same colour scheme as Anemo's page: otherwise the browser paints an opaque
    // background behind the frame instead of letting the card show through.
    root.style.colorScheme = theme.mode === 'dark' ? 'dark' : 'light'
  }

  /** "ui/panel.html" + "../lib/x.js" -> "lib/x.js" (paths inside the package). */
  function resolvePath(from, relative) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.indexOf('//') === 0) return null // an address elsewhere: not a package file
    var parts = relative.charAt(0) === '/' ? [] : from.split('/').slice(0, -1)
    relative.split('?')[0].split('#')[0].split('/').forEach(function (part) {
      if (part === '' || part === '.') return
      if (part === '..') parts.pop()
      else parts.push(part)
    })
    return parts.join('/')
  }

  function blobUrl(text, type) {
    return URL.createObjectURL(new Blob([text], { type: type }))
  }

  /**
   * Module scripts may import other files of the package ("./util.js"). A blob: URL has no
   * folder to resolve those against, so each module's relative imports are rewritten to the
   * blob: URLs of those files (made once each). Imports in a circle aren't supported.
   */
  function moduleLoader(files) {
    var urls = {}
    var making = {}
    var IMPORT = /(\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g
    function urlFor(path) {
      if (urls[path]) return urls[path]
      if (!(path in files)) throw new Error('The plugin file "' + path + '" is not part of this UI.')
      if (making[path]) throw new Error('"' + path + '" imports itself in a circle; plugin modules can’t do that.')
      making[path] = true
      var text = files[path].replace(IMPORT, function (whole, before, quote, spec) {
        return before + quote + urlFor(resolvePath(path, spec)) + quote
      })
      urls[path] = blobUrl(text, 'text/javascript')
      return urls[path]
    }
    return urlFor
  }

  /** Run one script and wait until it has run (so they run in order, as in a normal page). */
  function runScript(src, isModule) {
    return new Promise(function (resolve) {
      var script = document.createElement('script')
      if (isModule) script.type = 'module'
      script.src = src
      script.onload = function () {
        resolve()
      }
      script.onerror = function () {
        console.error('A plugin script could not run.')
        resolve()
      }
      document.body.appendChild(script)
    })
  }

  /** url(...) in a stylesheet that names a picture of the package: its data: URL. */
  function withPictures(text, path) {
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (whole, quote, ref) {
      var target = resolvePath(path || '', ref.trim())
      return target !== null && Object.prototype.hasOwnProperty.call(pictures, target) ? 'url("' + pictures[target] + '")' : whole
    })
  }

  function addStyle(text, path) {
    var style = document.createElement('style')
    if (path) style.setAttribute('data-path', path)
    style.textContent = withPictures(text, path)
    document.head.appendChild(style)
  }

  /** The entry's HTML as the page: its styles, its body, then its scripts in order. */
  function build(files) {
    var entry = files.entry || ''
    var scripts = {}
    ;(files.scripts || []).forEach(function (s) {
      scripts[s.path] = s.text
    })
    var styles = {}
    ;(files.styles || []).forEach(function (s) {
      styles[s.path] = s.text
    })
    var parsed = new DOMParser().parseFromString(files.html || '', 'text/html')
    var loadModule = moduleLoader(scripts)

    // <img src="sprites/idle.gif">: the package's pictures, as data: URLs.
    parsed.querySelectorAll('img[src]').forEach(function (el) {
      var path = resolvePath(entry, el.getAttribute('src') || '')
      if (path !== null && Object.prototype.hasOwnProperty.call(pictures, path)) el.setAttribute('src', pictures[path])
    })

    // Styles: <link rel="stylesheet"> and <style> of the entry, in their order, after base.css.
    parsed.querySelectorAll('link[rel~="stylesheet"], style').forEach(function (el) {
      if (el.tagName === 'STYLE') addStyle(el.textContent || '', entry)
      else {
        var path = resolvePath(entry, el.getAttribute('href') || '')
        if (path && path in styles) addStyle(styles[path], path)
      }
      el.remove()
    })
    if (parsed.title) document.title = parsed.title
    if (parsed.documentElement.lang) document.documentElement.lang = parsed.documentElement.lang

    // Scripts are taken out of the markup and run after it is in place.
    var queue = []
    parsed.querySelectorAll('script').forEach(function (el) {
      var isModule = (el.getAttribute('type') || '').toLowerCase() === 'module'
      var src = el.getAttribute('src')
      if (src) {
        var path = resolvePath(entry, src)
        if (path && path in scripts) queue.push({ path: path, module: isModule, src: null })
        else console.error('The plugin script "' + src + '" is not part of this UI.')
      } else if (el.textContent && el.textContent.trim()) {
        // An inline script: run from a blob: URL too (inline scripts aren't allowed).
        var text = el.textContent
        queue.push({ path: null, module: isModule, src: blobUrl(text, 'text/javascript') })
      }
      el.remove()
    })

    // The body: the entry's markup (event handler attributes like onclick="" don't run;
    // the CSP allows no inline script).
    var body = parsed.body
    for (var i = 0; i < body.attributes.length; i++) {
      document.body.setAttribute(body.attributes[i].name, body.attributes[i].value)
    }
    var nodes = Array.prototype.slice.call(body.childNodes)
    nodes.forEach(function (node) {
      document.body.appendChild(document.adoptNode(node))
    })

    // Run the scripts one after the other.
    return queue.reduce(function (previous, item) {
      return previous.then(function () {
        var src = item.src
        try {
          if (!src) src = item.module ? loadModule(item.path) : blobUrl(scripts[item.path], 'text/javascript')
        } catch (e) {
          console.error(e.message)
          return undefined
        }
        return runScript(src, item.module)
      })
    }, Promise.resolve())
  }

  // ---- The pointer, for an overlay ---------------------------------------------------------

  /**
   * While an overlay frame receives pointer events (the pointer is in one of its hit
   * regions), Anemo's page doesn't see the pointer move; this tells it where the pointer
   * is, so it can let clicks through again the moment the pointer leaves the regions.
   * Registered before any plugin script runs, in the capture phase: a plugin can't stop it.
   */
  function reportPointer() {
    function send(x, y) {
      try {
        apply(portPost, port, [{ pointer: x === null ? null : { x: x, y: y } }])
      } catch (e) {
        /* the port is closed */
      }
    }
    function move(event) {
      // A touch has no pointer that hovers: overlays don't take touches (see the guide).
      if (apply(pointerTypeOf, event, []) !== 'touch') send(apply(clientXOf, event, []), apply(clientYOf, event, []))
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerdown', move, true)
    // Out of the window altogether.
    document.addEventListener(
      'pointerout',
      function (event) {
        if (!apply(relatedTargetOf, event, [])) send(null)
      },
      true,
    )
    window.addEventListener('blur', function () {
      send(null)
    })
  }

  // ---- 2. The handshake --------------------------------------------------------------------

  function onWindowMessage(event) {
    // Only Anemo's page (our parent) starts us, once, and it has to hand over the port.
    if (event.source !== window.parent || port) return
    var data = event.data
    if (!data || data.anemo !== 1 || data.type !== 'init' || !event.ports || !event.ports[0]) return
    window.removeEventListener('message', onWindowMessage)
    port = event.ports[0]
    port.onmessage = onPortMessage // also starts the port

    applyTheme(data.theme)
    var files = data.files || {}
    ;(files.pictures || []).forEach(function (p) {
      if (p && typeof p.path === 'string' && typeof p.data_url === 'string') pictures[p.path] = p.data_url
    })
    if (data.slot === 'overlay') reportPointer()
    initData = {
      plugin: data.plugin,
      slot: data.slot,
      ui: data.ui,
      context: data.context,
      theme: data.theme,
      locale: data.locale,
      // The user's IANA time zone (Settings > General): "today" as Anemo's server means it.
      timeZone: data.timeZone,
      preview: data.preview === true,
      // Where things are on Anemo's screen (anemo.layout.get; layout.changed follows it).
      layout: data.layout || null,
    }
    // The plugin's scripts see `anemo.ready` resolved as soon as they run.
    resolveReady(initData)
    build(files).catch(function (e) {
      console.error(e)
    })
  }

  window.addEventListener('message', onWindowMessage)
  // Step 1: tell Anemo's page that the frame is ready for its init. The parent's origin is
  // Anemo's, but ours is opaque, so the target can't be named: "*" (the message has nothing
  // in it).
  window.parent.postMessage({ anemo: 1, type: 'hello' }, '*')
})()
