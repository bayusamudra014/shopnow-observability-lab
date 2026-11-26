import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies /api to the shop running in minikube (needs `minikube tunnel`).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://shop.local", changeOrigin: true } } },
});
