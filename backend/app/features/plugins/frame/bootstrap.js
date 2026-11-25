// Placeholder for the plugin frame's bootstrap (contract §6.2). The real one, written by
// the UI workstream, replaces this file: it says hello to the parent, takes the
// MessagePort and loads the plugin's files as blob: URLs.
'use strict'
parent.postMessage({ anemo: 1, type: 'hello' }, '*')
