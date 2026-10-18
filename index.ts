// opencode resolves a *local, unnamed* plugin directory (e.g. a bare
// `"plugins": ["/path/to/this/repo"]` or `file://` config entry) to
// `<directory>/index`, not to the directory itself — package.json's
// `main`/`exports` fields are never consulted for that resolution path
// (only an npm-installed, *named* package specifier goes through
// package.json). This file exists purely as that local-directory
// entrypoint; an installed npm package uses package.json's `exports`
// (-> ./dist/index.js) instead and never imports this file.
export { default, AntigravityProviderPlugin } from "./src/index.js"
