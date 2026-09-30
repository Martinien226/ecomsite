/**
 * Prépare le runtime ONNX Runtime Web (WASM) pour un hébergement 100 % local.
 *
 * Pourquoi ce script ?
 *  - Par défaut, Transformers.js télécharge le runtime WASM depuis un CDN tiers
 *    (jsDelivr). On préfère l'héberger nous-mêmes : rien ne sort de notre domaine,
 *    et l'application reste utilisable hors ligne.
 *  - Le fichier WASM « asyncify » fait ~26,9 Mo. Cloudflare Pages refuse les fichiers
 *    de plus de 25 MiB : on le découpe donc en morceaux de 10 MiB (`*.wasm.partN`)
 *    que le worker réassemble au chargement (voir src/workers/ort-loader.js).
 *
 * Les fichiers générés vont dans `public/ort/` (ignoré par git).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(racine, 'node_modules', 'onnxruntime-web', 'dist');
const cible = join(racine, 'public', 'ort');

// Variantes utilisées par Transformers.js : « asyncify » (WebGPU + WASM) et la version
// simple pour Safari < 26 (sans WebGPU).
const VARIANTES = ['ort-wasm-simd-threaded.asyncify', 'ort-wasm-simd-threaded'];
const TAILLE_MORCEAU = 10 * 1024 * 1024; // 10 MiB, très en dessous de la limite de 25 MiB

if (!existsSync(source)) {
  console.error('❌ onnxruntime-web est introuvable. Lancez d’abord « npm install ».');
  process.exit(1);
}

rmSync(cible, { recursive: true, force: true });
mkdirSync(cible, { recursive: true });

const manifeste = {};
const empreinte = createHash('sha256');
for (const nom of VARIANTES) {
  // Le module JavaScript (petit) est copié tel quel.
  copyFileSync(join(source, `${nom}.mjs`), join(cible, `${nom}.mjs`));

  // Le binaire WASM est découpé en morceaux numérotés.
  const wasm = readFileSync(join(source, `${nom}.wasm`));
  empreinte.update(wasm);
  const morceaux = [];
  for (let debut = 0, i = 0; debut < wasm.length; debut += TAILLE_MORCEAU, i++) {
    const fichier = `${nom}.wasm.part${i}`;
    writeFileSync(join(cible, fichier), wasm.subarray(debut, debut + TAILLE_MORCEAU));
    morceaux.push(fichier);
  }
  manifeste[nom] = { mjs: `${nom}.mjs`, parts: morceaux, size: wasm.length };
}
// L'empreinte sert de « numéro de version » au cache hors ligne (voir scripts/sw.template.js).
manifeste.version = empreinte.digest('hex').slice(0, 12);
writeFileSync(join(cible, 'manifest.json'), JSON.stringify(manifeste, null, 2));

const total = readdirSync(cible).reduce((somme, f) => somme + statSync(join(cible, f)).size, 0);
console.log(`✅ Runtime ONNX prêt dans public/ort/ (${(total / 1048576).toFixed(1)} Mo, aucun fichier > 10 MiB pour les .wasm)`);
