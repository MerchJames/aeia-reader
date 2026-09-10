import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {readFileSync} from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig(() => {
  return {
    /*
     * Who am I, and when was I made?
     *
     * Baked in at build time because it is otherwise unanswerable from inside a
     * packaged app: three platforms now ship from three different machines, and
     * "is this the build with the fix in it" turned into an afternoon of
     * grepping a compressed binary. One line in Settings settles it.
     */
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    /*
     * One 2 MB script was the whole app.
     *
     * Everything the reader might eventually open — the flow graph behind the
     * Multiverse, the maths renderer the assistant uses, the .docx importer,
     * the NLP the Refinery runs on — was parsed before the library could be
     * drawn, on every launch, by every reader, whether or not they ever opened
     * any of it.
     *
     * Splitting by library rather than by feature, because that is the boundary
     * that actually holds: a chunk is fetched when something imports it, so a
     * library only used by a lazily-mounted view stays on disk until that view
     * is mounted. It also means a release that touches app code does not
     * invalidate the reader's cached copy of React.
     *
     * Coarse groups on purpose. Splitting finely is how a chunk graph acquires
     * a cycle and the app dies on load with "cannot access before
     * initialization" — which no unit test can see. The e2e suite loads the
     * built bundle, so it does.
     */
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;
            // React first: everything else depends on it, and it must not be
            // dragged into a feature chunk by whichever one Rollup sees first.
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
            if (id.includes('@xyflow')) return 'flow';          // Multiverse, Crossings
            // Maths goes with the assistant, which is the only thing that
            // renders it — INCLUDING its remark/rehype plugins. Left to the
            // markdown rule below, `rehype-katex` lands in the core markdown
            // chunk, which the reader loads on sight, and drags 262 kB of
            // KaTeX in behind it for a feature most readers never open.
            // …and its whole plugin chain, down to `micromark-extension-math`
            // and `mdast-util-math`. Those match the markdown rule below on
            // name, and a module put in an EAGER chunk is eager however lazily
            // it is used — which is the trap this whole function sets.
            if (/katex|(remark|micromark-extension|mdast-util)-math/.test(id)) return 'katex';
            if (id.includes('compromise')) return 'nlp';        // the Refinery
            if (id.includes('mammoth')) return 'docx';          // document import
            if (id.includes('lucide-react')) return 'icons';
            if (id.includes('@dnd-kit')) return 'dnd';
            if (/node_modules\/(motion|framer-motion)\//.test(id)) return 'motion';
            // The markdown pipeline: remark, rehype, and the dozens of
            // micromark/mdast/hast packages underneath them.
            if (/(remark|rehype|micromark|mdast|hast|unist|unified|vfile|decode-named|character-entities|property-information|space-separated|comma-separated|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|trim-lines|bail|is-plain-obj|extend|devlop|estree|html-url-attributes)/.test(id)) return 'markdown';
            return 'vendor';
          },
        },
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
