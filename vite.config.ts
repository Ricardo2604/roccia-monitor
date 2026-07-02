import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
      manifest: {
        name: 'Roccia Monitor - Telemetría de Respaldo',
        short_name: 'Roccia',
        lang: 'es',
        description:
          'Estimación en tiempo real de la batería del power bank Roccia 30,000 mAh alimentando ONU VSOL + Router AX10',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0A0E15',
        theme_color: '#0A0E15',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
})
