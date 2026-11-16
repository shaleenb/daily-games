import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  accountId: "86d994e49102d0aab903ad6b3e39b1fe",
  worker: {
    name: "daily-games-hub",
    entrypoint: "./worker/index.js",
    compatibilityDate: "2026-11-16",
    assets: {
      runWorkerFirst: ["/api/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "daily-games-db", id: "1765201e-a08b-4d97-b890-5e8005de101d" }),
    },
    observability: {
      enabled: true,
      traces: { enabled: true },
    },
  },
});
