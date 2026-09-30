/**
 * Tests unitaires (sans navigateur) des fonctions pures : ordre de repli des modèles,
 * dimensions d'entrée, sigmoïde, adoucissement du masque, formats d'affichage, erreurs.
 * Les modules sont chargés par Vite (ils utilisent `import.meta.env`).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { assert, bilan, egal, test } from './outils.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(racine);
const vite = await createServer({ mode: 'production', logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
const charger = (chemin) => vite.ssrLoadModule(chemin);

console.log('Ordre de repli des modèles (production)');
const { listerCandidats } = await charger('/src/workers/candidats.js');
const vide = () => new Set();
const cles = (options) => listerCandidats({ echecs: vide(), manquants: vide(), ...options }).map((c) => c.cle);
const GPU = { id: 'webgpu', fp16: true };
const GPU_SANS_FP16 = { id: 'webgpu', fp16: false };
const WASM = { id: 'wasm', fp16: false };

await test('avec WebGPU : BiRefNet fp16 → fp32 (GPU) → q8 → fp32 (WASM), puis MODNet', () => {
  egal(cles({ preference: 'auto', moteurs: [GPU, WASM] }), [
    'birefnet|webgpu|fp16', 'birefnet|webgpu|fp32', 'birefnet|wasm|q8', 'birefnet|wasm|fp32',
    'modnet|webgpu|fp32', 'modnet|wasm|fp32', 'modnet|wasm|q8',
  ]);
});
await test('GPU sans fp16 : on saute le format fp16', () => {
  assert(!cles({ preference: 'auto', moteurs: [GPU_SANS_FP16, WASM] }).some((c) => c.endsWith('fp16')), 'fp16 ne doit pas être proposé');
});
await test('sans WebGPU : uniquement WASM, BiRefNet d’abord', () => {
  const liste = cles({ preference: 'auto', moteurs: [WASM] });
  egal(liste, ['birefnet|wasm|q8', 'birefnet|wasm|fp32', 'modnet|wasm|fp32', 'modnet|wasm|q8']);
});
await test('préférences « précis » (BiRefNet seul) et « rapide » (MODNet seul)', () => {
  assert(cles({ preference: 'precis', moteurs: [GPU, WASM] }).every((c) => c.startsWith('birefnet')), 'précis');
  assert(cles({ preference: 'rapide', moteurs: [GPU, WASM] }).every((c) => c.startsWith('modnet')), 'rapide');
});
await test('combinaisons en échec et fichiers manquants sont écartés', () => {
  const liste = cles({
    preference: 'auto',
    moteurs: [GPU, WASM],
    echecs: new Set(['birefnet|webgpu|fp32']),
    manquants: new Set(['birefnet|fp16', 'modnet|q8']),
  });
  assert(!liste.includes('birefnet|webgpu|fp16') && !liste.includes('birefnet|webgpu|fp32') && !liste.includes('modnet|wasm|q8'), `liste : ${liste}`);
  assert(liste[0] === 'birefnet|wasm|q8', `premier candidat : ${liste[0]}`);
});
await test('les modèles de production sont bien BiRefNet lite et MODNet (jamais RMBG)', async () => {
  const { MODELES, MODE_TEST } = await charger('/src/config.js');
  assert(!MODE_TEST && !MODELES.test, 'le modèle de test ne doit pas exister en production');
  egal(Object.values(MODELES).map((m) => m.depot), ['onnx-community/BiRefNet_lite', 'Xenova/modnet']);
});

console.log('\nTraitement d’image (fonctions pures)');
const img = await charger('/src/workers/imagerie.js');
await test('dimensions d’entrée : carré fixe pour BiRefNet, multiples de 32 pour MODNet', () => {
  egal(img.dimensionsEntree({ mode: 'carre', cote: 1024 }, 5472, 3648), { w: 1024, h: 1024 });
  const taille = { mode: 'surface', surface: 512 * 512, multiple: 32 };
  for (const [l, h] of [[4000, 3000], [3000, 4000], [512, 512], [10000, 100], [100, 10000]]) {
    const { w, h: hh } = img.dimensionsEntree(taille, l, h);
    assert(w % 32 === 0 && hh % 32 === 0 && w >= 32 && hh >= 32, `${l}×${h} → ${w}×${hh} (multiples de 32 attendus)`);
  }
  const { w, h } = img.dimensionsEntree(taille, 4000, 3000);
  assert(Math.abs(w / h - 4 / 3) < 0.06, `proportions conservées (${w}×${h})`);
  assert(Math.abs(w * h - 262144) / 262144 < 0.2, `surface proche de 512² (${w * h})`);
});
await test('sortie du réseau : probabilités conservées, logits passés à la sigmoïde', () => {
  const proba = img.versMasque(Float32Array.from([0, 0.25, 1]));
  egal(Array.from(proba), [0, 0.25, 1]);
  const logits = img.versMasque(Float32Array.from([-12, 0, 12]));
  assert(logits[0] < 0.001 && Math.abs(logits[1] - 0.5) < 1e-6 && logits[2] > 0.999, `logits : ${Array.from(logits)}`);
});
await test('adoucissement : plages 0-255, zones pleines intactes, bord progressif', () => {
  const [L, H] = [16, 4];
  const uni = img.adoucirMasque(new Float32Array(L * H).fill(1), L, H);
  assert(uni.every((v) => v === 255), 'masque plein inchangé');
  assert(img.adoucirMasque(new Float32Array(L * H), L, H).every((v) => v === 0), 'masque vide inchangé');

  const marche = new Float32Array(L * H);
  for (let y = 0; y < H; y++) for (let x = L / 2; x < L; x++) marche[y * L + x] = 1;
  const doux = img.adoucirMasque(marche, L, H);
  const ligne = Array.from(doux.slice(0, L));
  const intermediaires = ligne.filter((v) => v > 0 && v < 255).length;
  assert(intermediaires >= 1, `le bord doit avoir des valeurs intermédiaires : ${ligne}`);
  assert(ligne.every((v, i) => i === 0 || v >= ligne[i - 1]), `transition monotone : ${ligne}`);
  assert(ligne[0] === 0 && ligne[L - 1] === 255, 'extrémités inchangées');
});

console.log('\nAffichage et erreurs');
const fmt = await charger('/src/lib/format.js');
await test('formats : octets, mégapixels, durées, noms de fichiers', () => {
  assert(fmt.formaterOctets(1536) === '2 Ko', fmt.formaterOctets(1536));
  assert(/^5\s?Mo$/.test(fmt.formaterOctets(5 * 1048576)), fmt.formaterOctets(5 * 1048576));
  assert(/^12,2\s?Mpx$/.test(fmt.formaterMegapixels(4032, 3024)), fmt.formaterMegapixels(4032, 3024));
  assert(/^12,3\s?s$/.test(fmt.formaterDuree(12300)), fmt.formaterDuree(12300));
  egal([fmt.nomSansExtension('ma photo.final.JPG'), fmt.nomSansExtension('.jpg'), fmt.nomFichierSur('a/b:c?.png')], ['ma photo.final', 'image', 'a_b_c_.png']);
});
const err = await charger('/src/lib/erreurs.js');
await test('erreurs : messages français, détection réseau et mémoire', () => {
  assert(/JPG, PNG ou WEBP/.test(err.messagePourCode('format')), 'message format');
  assert(err.messagePourCode('code-inconnu') === err.messagePourCode('inconnue'), 'code inconnu → message générique');
  assert(err.estErreurReseau(new TypeError('Failed to fetch')) && err.estErreurReseau(new Error('Load failed')), 'réseau');
  assert(!err.estErreurReseau(new Error('Unsupported model type')), 'pas réseau');
  assert(err.estErreurMemoire(new RangeError('Array buffer allocation failed')), 'mémoire');
  egal(new err.ErreurDetourage('nimporte-quoi').code, 'inconnue');
});

await vite.close();
process.exit(bilan());
