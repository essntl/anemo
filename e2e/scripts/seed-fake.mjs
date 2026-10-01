// Sets up a fresh test install the way a user would on first use: adds the
// scripted "fake" provider, imports its models and makes one the default for chat.
// Used by run-isolated.sh. Never run this against a real install.
//
//   E2E_BASE_URL=http://localhost:8090 E2E_PASSWORD=... node e2e/scripts/seed-fake.mjs

const base = process.env.E2E_BASE_URL
const password = process.env.E2E_PASSWORD
if (!base || !password) throw new Error('Set E2E_BASE_URL and E2E_PASSWORD')

let cookie = ''

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

await call('POST', '/api/auth/login', { username: process.env.E2E_USERNAME ?? 'admin', password })
const provider = await call('POST', '/api/providers', { name: 'Fake models', type: 'fake' })
await call('POST', `/api/providers/${provider.id}/models/import`, { model_keys: ['echo', 'slow', 'agent'] })
const models = await call('GET', '/api/models')
const echo = models.find((m) => m.provider_id === provider.id && m.model_key === 'echo')
await call('PUT', '/api/settings/models', { chat: echo.id })
await call('POST', '/api/auth/logout')
console.log('Test install is set up: fake provider, default chat model "echo".')
