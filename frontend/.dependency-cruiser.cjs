/**
 * Import boundaries for the frontend (`npm run lint:imports`, run in CI). See CLAUDE.md.
 * The violations that existed when these rules were added are listed in
 * .dependency-cruiser-known-violations.json so they don't fail the check; new ones do.
 * Regenerate that list only when one of them is removed: `npm run lint:imports:baseline`.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules must not import each other in a circle.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-code-is-not-feature-code',
      severity: 'error',
      comment: 'components/, lib/, hooks/ and api/ are used by every feature, so they must not depend on one.',
      from: { path: '^src/(components|lib|hooks|api)/' },
      to: { path: '^src/features/' },
    },
    {
      name: 'features-do-not-import-the-app-shell',
      severity: 'error',
      comment:
        'app/ puts the features together (router, layout, sidebar); a feature must not depend on that. ' +
        'The shared stores in app/ (projectStore, sidebarStore, mobileNav) are fine.',
      from: { path: '^src/features/' },
      to: { path: '^src/app/', pathNot: '^src/app/(projectStore|sidebarStore|mobileNavStore|mobileNav)\\.tsx?$' },
    },
    {
      name: 'tests-are-not-imported',
      severity: 'error',
      from: { pathNot: '\\.test\\.tsx?$' },
      to: { path: '\\.test\\.tsx?$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'src/api/schema\\.d\\.ts' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.app.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
}
