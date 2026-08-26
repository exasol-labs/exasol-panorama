/// <reference types="vite/client" />
declare module '*.css';

/**
 * Startup connection details, replaced at build time by the dev server.
 * A production build is given `null`, so no secret can reach a built artifact.
 */
declare const __PANORAMA_STARTUP__: unknown;
