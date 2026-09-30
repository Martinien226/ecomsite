/**
 * Chargement et exécution du modèle de segmentation (dans le Web Worker).
 *
 * Stratégie de repli, du plus qualitatif au plus compatible :
 *   BiRefNet lite (WebGPU fp16 → WebGPU fp32 → WASM q8 → WASM fp32)
 *   puis MODNet (mêmes étapes).
 * Une combinaison qui échoue (téléchargement, mémoire, erreur GPU…) est mise de côté
 * et la suivante est essayée automatiquement.
 */
import { AutoModel, Tensor, env } from '@huggingface/transformers';
import { MODE_TEST } from '../config.js';
import { ErreurDetourage, estErreurMemoire, estErreurReseau } from '../lib/erreurs.js';
import { listerCandidats } from './candidats.js';

/** Combinaisons « modèle|moteur|dtype » qui ont échoué pendant cette session. */
const echecs = new Set();
/** Fichiers de poids absents du dépôt (« modèle|dtype ») : inutile de les redemander avec un autre moteur. */
const manquants = new Set();
let modeleCourant = null;
let chargementEnCours = null;
let configureEnv = false;

/** Réglages globaux de Transformers.js (une seule fois). */
function configurerEnvironnement(racine) {
  if (configureEnv) return;
  configureEnv = true;
  // Jamais de modèles « locaux » : sur un hébergement statique, une URL inconnue renvoie
  // souvent la page d'accueil (HTML) au lieu d'une erreur 404, ce qui casserait le chargement.
  env.allowLocalModels = false;
  env.useBrowserCache = true; // le modèle est gardé dans le cache du navigateur (Cache API)
  if (MODE_TEST) {
    env.remoteHost = new URL('__fixtures__/hf/', racine).href;
  }
}

/** Moteurs utilisables sur cet appareil, dans l'ordre de préférence. */
async function moteursDisponibles() {
  const moteurs = [];
  try {
    const adaptateur = await navigator.gpu?.requestAdapter();
    if (adaptateur) moteurs.push({ id: 'webgpu', fp16: adaptateur.features.has('shader-f16') });
  } catch {
    /* WebGPU indisponible : on passe au WASM */
  }
  moteurs.push({ id: 'wasm', fp16: false });
  return moteurs;
}

/** Liste ordonnée des candidats (modèle × moteur × dtype) pas encore éliminés. */
async function candidats(preference) {
  return listerCandidats({ preference, moteurs: await moteursDisponibles(), echecs, manquants });
}

const estFichierManquant = (e) =>
  e?.name === 'ModelFileNotFoundError' || /could not locate|not found|404/i.test(e?.message ?? '');

/**
 * Charge (ou réutilise) le meilleur modèle disponible.
 * @param {{ preference: string, racine: string, onProgression: (p: {loaded:number,total:number}) => void }} options
 */
export async function obtenirModele({ preference, racine, onProgression }) {
  configurerEnvironnement(racine);
  if (modeleCourant && modeleCourant.preference === preference) return modeleCourant;
  chargementEnCours ??= charger(preference, onProgression).finally(() => {
    chargementEnCours = null;
  });
  return chargementEnCours;
}

async function charger(preference, onProgression) {
  if (modeleCourant) await liberer();
  const liste = await candidats(preference);
  let reseau = null;
  let derniere = null;

  for (const candidat of liste) {
    try {
      const instance = await AutoModel.from_pretrained(candidat.config.depot, {
        device: candidat.moteur,
        dtype: candidat.dtype,
        progress_callback: (info) => {
          if (info.status === 'progress_total') onProgression?.({ loaded: info.loaded, total: info.total });
        },
      });
      const session = instance.sessions?.model ?? Object.values(instance.sessions ?? {})[0];
      modeleCourant = {
        preference,
        instance,
        cle: candidat.cle,
        config: candidat.config,
        moteur: candidat.moteur,
        dtype: candidat.dtype,
        nomEntree: session?.inputNames?.[0] ?? 'input',
        nomSortie: session?.outputNames?.[0],
      };
      return modeleCourant;
    } catch (erreur) {
      console.warn(`[modèle] échec de ${candidat.cle} :`, erreur);
      derniere = erreur;
      // Coupure réseau : inutile d'insister avec les autres combinaisons, elles échoueront aussi.
      // On ne met PAS la combinaison de côté : un nouvel essai, une fois la connexion revenue, doit pouvoir réussir.
      if (!estFichierManquant(erreur) && estErreurReseau(erreur)) {
        reseau = erreur;
        break;
      }
      // Fichier absent du dépôt (404), mémoire, erreur GPU… : on écarte cette combinaison et on tente la suivante.
      echecs.add(candidat.cle);
      if (estFichierManquant(erreur)) manquants.add(`${candidat.config.id}|${candidat.dtype}`);
    }
  }
  if (reseau) throw new ErreurDetourage('modele-reseau', String(reseau?.message ?? reseau));
  throw new ErreurDetourage('modele-indisponible', String(derniere?.message ?? 'Aucun modèle utilisable'));
}

/** Libère la mémoire (GPU/CPU) du modèle courant. */
export async function liberer() {
  const courant = modeleCourant;
  modeleCourant = null;
  try {
    await courant?.instance?.dispose?.();
  } catch {
    /* sans importance */
  }
}

/**
 * Exécute le réseau sur une entrée déjà normalisée (NCHW float32).
 * En cas d'échec (erreur GPU, mémoire…), on écarte la combinaison fautive et on recommence
 * avec la suivante de la liste.
 *
 * @returns {Promise<{ masque: Float32Array, largeur: number, hauteur: number, modele: object }>}
 */
export async function inferer({ preference, racine, onProgression, preparerEntree }) {
  let derniereErreur = null;
  for (let essai = 0; essai < 6; essai++) {
    const modele = await obtenirModele({ preference, racine, onProgression });
    try {
      const entree = await preparerEntree(modele);
      const tenseur = new Tensor('float32', entree.donnees, [1, 3, entree.hauteur, entree.largeur]);
      const sorties = await modele.instance({ [modele.nomEntree]: tenseur });
      const sortie = (modele.nomSortie && sorties[modele.nomSortie]) || Object.values(sorties)[0];
      const [hauteur, largeur] = sortie.dims.slice(-2);
      return { masque: enFloat32(sortie), largeur, hauteur, modele };
    } catch (erreur) {
      console.warn(`[inférence] échec de ${modele.cle} :`, erreur);
      derniereErreur = erreur;
      echecs.add(modele.cle);
      await liberer();
      if (erreur instanceof ErreurDetourage) throw erreur;
    }
  }
  throw estErreurMemoire(derniereErreur)
    ? new ErreurDetourage('memoire', String(derniereErreur?.message))
    : new ErreurDetourage('modele-indisponible', String(derniereErreur?.message ?? derniereErreur));
}

/** Convertit la sortie du réseau (float32 ou float16) en Float32Array. */
function enFloat32(tenseur) {
  const donnees = tenseur.data;
  if (donnees instanceof Float32Array) return donnees;
  if (tenseur.type === 'float16' && donnees instanceof Uint16Array) return decoderFloat16(donnees);
  return Float32Array.from(donnees);
}

/** Décode des demi-flottants IEEE 754 (stockés dans un Uint16Array). */
function decoderFloat16(source) {
  const sortie = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const h = source[i];
    const signe = h & 0x8000 ? -1 : 1;
    const exposant = (h >> 10) & 0x1f;
    const fraction = h & 0x3ff;
    sortie[i] =
      exposant === 0
        ? signe * 2 ** -14 * (fraction / 1024)
        : exposant === 0x1f
          ? fraction ? NaN : signe * Infinity
          : signe * 2 ** (exposant - 15) * (1 + fraction / 1024);
  }
  return sortie;
}
