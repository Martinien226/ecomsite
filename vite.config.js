import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const racine = dirname(fileURLToPath(import.meta.url));

/** Liste récursivement les fichiers d'un dossier (chemins relatifs, séparateur « / »). */
function lister(dossier, base = dossier) {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((entree) => {
    const chemin = join(dossier, entree.name);
    return entree.isDirectory() ? lister(chemin, base) : [relative(base, chemin).split(sep).join('/')];
  });
}

/**
 * Plugin PWA maison (aucune dépendance) : après le build, génère dist/sw.js à partir de
 * scripts/sw.template.js en y insérant la liste des fichiers à mettre en cache
 * et un numéro de version calculé sur leur contenu (nouvelle version = nouveau cache).
 */
function pluginServiceWorker() {
  let dossierSortie;
  return {
    name: 'detoure-service-worker',
    apply: 'build',
    configResolved(config) {
      dossierSortie = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const fichiers = lister(dossierSortie).filter(
        (f) => !f.startsWith('ort/') && !['sw.js', '_headers', '_redirects'].includes(f) && !f.endsWith('.map'),
      );
      const empreinte = createHash('sha256');
      for (const f of fichiers.sort()) empreinte.update(f).update(readFileSync(join(dossierSortie, f)));
      const manifesteOrt = join(dossierSortie, 'ort', 'manifest.json');
      const versionOrt = existsSync(manifesteOrt) ? JSON.parse(readFileSync(manifesteOrt, 'utf8')).version : 'aucune';

      const modele = readFileSync(join(racine, 'scripts', 'sw.template.js'), 'utf8');
      const sw = modele
        .replaceAll('__VERSION__', empreinte.digest('hex').slice(0, 12))
        .replaceAll('__VERSION_ORT__', versionOrt)
        .replaceAll('__FICHIERS__', JSON.stringify(['./', ...fichiers], null, 2));
      writeFileSync(join(dossierSortie, 'sw.js'), sw);
      console.log(`\n✓ Service worker généré (${fichiers.length} fichiers mis en cache hors ligne)`);
    },
  };
}

/**
 * Transformers.js contient une référence par défaut vers le binaire WASM d'ONNX Runtime
 * (26,9 Mo) : Vite l'ajouterait au build. Or ce fichier ne sert jamais, car le worker fournit
 * lui-même le binaire depuis ort/ (voir src/workers/ort-loader.js). On le retire pour respecter
 * la limite de 25 MiB par fichier de Cloudflare Pages et alléger le cache hors ligne.
 */
function pluginSansWasmEmbarque() {
  return {
    name: 'detoure-sans-wasm-embarque',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const nom of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(nom)) delete bundle[nom];
      }
    },
  };
}

/**
 * MODE TEST uniquement (`vite --mode test`) : sert le dossier tests/fixtures sous /__fixtures__/.
 * Il contient un petit modèle libre qui remplace le téléchargement depuis Hugging Face.
 */
function pluginFixturesDeTest() {
  const TYPES = { '.json': 'application/json', '.onnx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  const intergiciel = (req, res, suite) => {
    if (!req.url?.startsWith('/__fixtures__/')) return suite();
    const chemin = normalize(join(racine, 'tests', 'fixtures', decodeURIComponent(req.url.slice('/__fixtures__/'.length).split('?')[0])));
    if (!chemin.startsWith(join(racine, 'tests', 'fixtures')) || !existsSync(chemin) || !statSync(chemin).isFile()) {
      res.statusCode = 404;
      return res.end('introuvable');
    }
    res.setHeader('Content-Type', TYPES[extname(chemin)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', statSync(chemin).size);
    // Aucune mise en cache HTTP : ainsi, seul le Cache API de l'application peut conserver le modèle (test hors ligne fiable).
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.DETOURE_TEST_LENT) {
      // Connexion lente simulée (le test de la barre de progression l'active) : 256 Ko toutes les 150 ms.
      const flux = createReadStream(chemin, { highWaterMark: 256 * 1024 });
      flux.on('data', (morceau) => {
        flux.pause();
        res.write(morceau);
        setTimeout(() => flux.resume(), 150);
      });
      flux.on('end', () => res.end());
      return;
    }
    createReadStream(chemin).pipe(res);
  };
  return {
    name: 'detoure-fixtures-de-test',
    // Attention : ne rien retourner (un retour de fonction serait interprété comme un « hook post-middleware »).
    configureServer(serveur) {
      serveur.middlewares.use(intergiciel);
    },
    configurePreviewServer(serveur) {
      serveur.middlewares.use(intergiciel);
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Chemins relatifs : le même build fonctionne à la racine d'un domaine (Cloudflare Pages)
  // comme dans un sous-dossier (GitHub Pages : https://utilisateur.github.io/depot/).
  base: './',
  plugins: [pluginSansWasmEmbarque(), pluginServiceWorker(), ...(mode === 'test' ? [pluginFixturesDeTest()] : [])],
  worker: { format: 'es' },
  // Transformers.js charge ONNX Runtime dynamiquement : on évite le pré-bundling de Vite.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000, // Transformers.js pèse ~1 Mo : normal
  },
}));
