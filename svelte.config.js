import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  // All Svelte components use runes mode.
  compilerOptions: { runes: true },
};
