/**
 * The animation features are loaded lazily (lib/motionFeatures.ts, <LazyMotion> in
 * app/App.tsx). A `motion.div` would bring all of them back into the first bundle, so
 * components use `m.div`.
 */
const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('motion stays out of the first bundle', () => {
  it('found the source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })

  it('imports `m`, not `motion`, from motion/react', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*['"]motion\/react['"]/.test(text))
      .map(([file]) => file)
    expect(offenders, 'Use `m` from motion/react (features load through <LazyMotion>)').toEqual([])
  })

  it('loads the features lazily, from one place', () => {
    const app = sources['/src/app/App.tsx']
    expect(app).toMatch(/<LazyMotion features=\{loadMotionFeatures\}>/)
    expect(app).toMatch(/import\('@\/lib\/motionFeatures'\)/)
    const eager = Object.entries(sources)
      .filter(([, text]) => /\b(domMax|domAnimation)\b/.test(text))
      .map(([file]) => file)
    expect(eager).toEqual(['/src/lib/motionFeatures.ts'])
  })
})
