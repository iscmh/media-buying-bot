// Vitest alias target for the `server-only` module. Vitest runs modules
// directly (no Next.js build step) so the real package's runtime guard
// would throw; we no-op it here.
export {};
