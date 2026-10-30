import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Relative base so the static build works at any path (GitHub Pages serves it under /buck-format/).
export default defineConfig({base:'./',plugins:[react()],worker:{format:'es'}});
