# VAVOO Clean Addon

Stremio addon only for VAVOO: catalogs by country, resolves clean HLS using viewer's IP (ipLocation in ping signature). Includes a simple landing page.

## Run locally

- npm install
- npm run build
- PORT=7019 npm start
- Open http://localhost:7019/manifest.json

## Deploy to BeamUp (from this VAVOO folder)

- beamup
- beamup deploy

Notes:
- Procfile: `web: npm start`
- Root not needed; this folder is self-contained.
