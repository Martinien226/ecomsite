/**
 * Prépare ONNX Runtime Web (le moteur qui exécute le modèle) pour qu'il utilise
 * nos fichiers auto-hébergés (dossier `ort/`) au lieu d'un CDN externe.
 *
 * Le binaire WASM est stocké en morceaux (voir scripts/prepare-ort.mjs, à cause de la
 * limite de 25 MiB par fichier de Cloudflare Pages) : on les télécharge puis on les
 * réassemble en mémoire avant de les donner à ONNX Runtime.
 * Le service worker met ces fichiers en cache : ils fonctionnent ensuite hors ligne.
 */
import { env } from '@huggingface/transformers';
import { DOSSIER_ORT } from '../config.js';
import { ErreurDetourage, estErreurReseau } from '../lib/erreurs.js';

let preparation = null;

/**
 * @param {string} racine    URL de la racine du site (avec « / » final)
 * @param {string} variante  « ort-wasm-simd-threaded.asyncify » (défaut) ou « ort-wasm-simd-threaded »
 */
export function preparerOrt(racine, variante) {
  // On ne prépare qu'une seule fois, même si plusieurs images arrivent.
  preparation ??= configurer(racine, variante).catch((erreur) => {
    preparation = null; // permet de réessayer plus tard
    throw erreur;
  });
  return preparation;
}

async function configurer(racine, variante) {
  const dossier = new URL(DOSSIER_ORT, racine);
  try {
    const reponseManifeste = await fetch(new URL('manifest.json', dossier));
    if (!reponseManifeste.ok) throw new Error(`manifest.json : HTTP ${reponseManifeste.status}`);
    const manifeste = await reponseManifeste.json();
    const info = manifeste[variante];
    if (!info) throw new Error(`Variante ONNX inconnue : ${variante}`);

    // Téléchargement parallèle des morceaux, puis réassemblage dans l'ordre.
    const morceaux = await Promise.all(
      info.parts.map(async (nom) => {
        const reponse = await fetch(new URL(nom, dossier));
        if (!reponse.ok) throw new Error(`${nom} : HTTP ${reponse.status}`);
        return new Uint8Array(await reponse.arrayBuffer());
      }),
    );
    const binaire = new Uint8Array(info.size);
    let decalage = 0;
    for (const morceau of morceaux) {
      binaire.set(morceau, decalage);
      decalage += morceau.byteLength;
    }

    const wasm = env.backends.onnx.wasm;
    wasm.wasmBinary = binaire;
    wasm.wasmPaths = {
      mjs: new URL(info.mjs, dossier).href,
      wasm: new URL(`${variante}.wasm`, dossier).href, // non utilisé : le binaire est déjà fourni
    };
    // Transformers.js ne doit pas re-télécharger lui-même le runtime.
    env.useWasmCache = false;
  } catch (erreur) {
    if (erreur instanceof ErreurDetourage) throw erreur;
    throw new ErreurDetourage(
      estErreurReseau(erreur) ? 'modele-reseau' : 'modele-indisponible',
      `Runtime ONNX : ${erreur?.message ?? erreur}`,
    );
  }
}
