/**
 * Chargement et exécution du modèle de segmentation (dans le Web Worker).
 *
 * Stratégie de repli, du plus qualitatif au plus compatible (voir candidats.js) :
 *   WebGPU disponible : BiRefNet lite (fp16 → fp32), puis MODNet (WebGPU, puis WASM)
 *   sinon             : MODNet en WASM
 *
 * IMPORTANT — après une erreur du moteur ONNX en WebAssembly (mémoire épuisée, par exemple),
 * le runtime du worker reste instable : les modèles suivants échouent à leur tour, même s'ils
 * sont bons (constaté en test). On ne continue donc PAS dans ce worker : on lève l'erreur
 * « redemarrage », la page relance le travail dans un worker neuf et lui transmet la liste des
 * combinaisons déjà écartées (voir src/lib/moteur.js). Seule l'absence d'un fichier (404),
 * qui ne touche pas au moteur, permet de passer au candidat suivant sur place.
 */
import { AutoModel, Tensor, env } from '@huggingface/transformers';
import { MODE_TEST } from '../config.js';
import { ErreurDetourage, estErreurMemoire, estErreurReseau } from '../lib/erreurs.js';
import { listerCandidats } from './candidats.js';

/** Combinaisons « modèle|moteur|dtype » qui ont échoué. */
const echecs = new Set();
/** Fichiers de poids absents du dépôt (« modèle|dtype ») : inutile de les redemander avec un autre moteur. */
const manquants = new Set();
/**
 * Journal lisible des échecs (« modèle|moteur|dtype → message »), joint aux détails techniques
 * affichés à l'utilisateur : sans lui, l'erreur finale ne dirait pas POURQUOI aucun modèle n'a démarré.
 */
const journal = [];
let infoMoteurs = '';
let webgpuDisponible = false;

function noter(cle, erreur) {
  const texte = String(erreur?.message ?? erreur).replace(/\s+/g, ' ').slice(0, 300);
  journal.push(`${cle} → ${texte}`);
  if (journal.length > 14) journal.shift();
}
const detailJournal = () => [infoMoteurs, ...journal].filter(Boolean).join('\n');

/** Mémoire des échecs, à transmettre au worker suivant lors d'un redémarrage. */
export function exporterEtat() {
  return { echecs: [...echecs], manquants: [...manquants], journal: [...journal] };
}

/** Reprend la mémoire des échecs d'un worker précédent (remplace l'état courant). */
export function importerEtat(etat) {
  echecs.clear();
  manquants.clear();
  journal.length = 0;
  for (const cle of etat?.echecs ?? []) echecs.add(cle);
  for (const cle of etat?.manquants ?? []) manquants.add(cle);
  journal.push(...(etat?.journal ?? []));
}

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

/** Moteurs utilisables sur cet appareil, dans l'ordre de préférence (avec la raison si WebGPU manque). */
async function moteursDisponibles() {
  const moteurs = [];
  webgpuDisponible = false;
  let gpu = 'API WebGPU absente du navigateur';
  if (navigator.gpu) {
    try {
      const adaptateur =
        (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await navigator.gpu.requestAdapter());
      if (adaptateur) {
        webgpuDisponible = true;
        moteurs.push({ id: 'webgpu', fp16: adaptateur.features.has('shader-f16') });
        const info = adaptateur.info ?? {};
        gpu = `adaptateur ${[info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'inconnu'}`;
      } else {
        gpu = 'aucun adaptateur (accélération matérielle désactivée ou carte graphique non prise en charge ? voir chrome://gpu)';
      }
    } catch (erreur) {
      gpu = `erreur : ${erreur?.message ?? erreur}`;
    }
  }
  moteurs.push({ id: 'wasm', fp16: false });
  infoMoteurs = `WebGPU (worker) : ${gpu}\nmoteurs : ${moteurs.map((m) => m.id + (m.fp16 ? ' (fp16)' : '')).join(', ')}`;
  return moteurs;
}

/** Liste ordonnée des candidats (modèle × moteur × dtype) pas encore éliminés. */
async function candidats(preference) {
  return listerCandidats({ preference, moteurs: await moteursDisponibles(), echecs, manquants });
}

// Seule une vraie absence de fichier (404) compte ici : d'autres erreurs contiennent « not found »
// (ex. opérateur ONNX non géré) et ne doivent pas faire écarter les autres moteurs.
const estFichierManquant = (e) => e?.name === 'ModelFileNotFoundError' || /could not locate file/i.test(e?.message ?? '');

/**
 * Après un échec du moteur : s'il reste des candidats, on demande un redémarrage du worker ;
 * sinon on produit l'erreur définitive (avec le journal complet).
 */
async function erreurApresEchec(preference, erreur) {
  if ((await candidats(preference)).length > 0) return new ErreurDetourage('redemarrage', detailJournal(), exporterEtat());
  return new ErreurDetourage(estErreurMemoire(erreur) ? 'memoire' : 'modele-indisponible', detailJournal());
}

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
  if (!liste.length) {
    // Mode « Précis » sans WebGPU : inutile de télécharger quoi que ce soit.
    if (preference === 'precis' && !webgpuDisponible) throw new ErreurDetourage('webgpu-requis', detailJournal());
    throw new ErreurDetourage('modele-indisponible', detailJournal() || 'Aucun modèle utilisable');
  }

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
      noter(candidat.cle, erreur);

      // Coupure réseau : inutile d'insister avec les autres combinaisons, elles échoueront aussi.
      // On ne met PAS la combinaison de côté : un nouvel essai, une fois la connexion revenue, doit pouvoir réussir.
      if (!estFichierManquant(erreur) && estErreurReseau(erreur)) {
        throw new ErreurDetourage('modele-reseau', detailJournal());
      }

      echecs.add(candidat.cle);
      if (estFichierManquant(erreur)) {
        // Fichier absent du dépôt (404) : le moteur n'est pas touché, on passe au format suivant sur place.
        manquants.add(`${candidat.config.id}|${candidat.dtype}`);
        continue;
      }
      // Toute autre erreur (mémoire, GPU, opérateur non géré…) : le moteur n'est plus fiable → nouveau worker.
      throw await erreurApresEchec(preference, erreur);
    }
  }
  throw new ErreurDetourage('modele-indisponible', detailJournal() || String(derniere?.message ?? 'Aucun modèle utilisable'));
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
 * En cas d'échec, la combinaison fautive est écartée et on demande un worker neuf (voir l'en-tête).
 *
 * @returns {Promise<{ masque: Float32Array, largeur: number, hauteur: number, modele: object }>}
 */
export async function inferer({ preference, racine, onProgression, preparerEntree }) {
  const modele = await obtenirModele({ preference, racine, onProgression });
  try {
    const entree = await preparerEntree(modele);
    const tenseur = new Tensor('float32', entree.donnees, [1, 3, entree.hauteur, entree.largeur]);
    const sorties = await modele.instance({ [modele.nomEntree]: tenseur });
    const sortie = (modele.nomSortie && sorties[modele.nomSortie]) || Object.values(sorties)[0];
    const [hauteur, largeur] = sortie.dims.slice(-2);
    return { masque: enFloat32(sortie), largeur, hauteur, modele };
  } catch (erreur) {
    if (erreur instanceof ErreurDetourage) throw erreur;
    console.warn(`[inférence] échec de ${modele.cle} :`, erreur);
    noter(`${modele.cle} (inférence)`, erreur);
    echecs.add(modele.cle);
    throw await erreurApresEchec(preference, erreur);
  }
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
