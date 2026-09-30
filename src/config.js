/**
 * Configuration centrale de l'application : formats acceptés, limites, modèles d'IA.
 * Tout ce qui se règle (qualité, tailles, noms de modèles) est ici.
 */

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Types MIME acceptés en entrée. */
export const FORMATS_ACCEPTES = ['image/jpeg', 'image/png', 'image/webp'];

/** Taille maximale d'un fichier (un JPG de 20 Mpx dépasse rarement 15 Mo). */
export const TAILLE_MAX_FICHIER = 60 * 1024 * 1024;

/**
 * Nombre maximal de pixels traités en pleine résolution.
 * Au-delà, l'image est réduite (et l'utilisateur est prévenu).
 * iOS/Safari limite la surface d'un canvas à ~16,7 Mpx : on reste en dessous.
 */
export const PIXELS_MAX = 40_000_000;
export const PIXELS_MAX_IOS = 16_000_000;

/** Côté maximal (en pixels) des aperçus affichés à l'écran (le PNG téléchargé reste en pleine résolution). */
export const APERCU_COTE_MAX = 1600;

/**
 * Adoucissement des contours (« feathering ») appliqué au masque avant de
 * l'agrandir à la taille d'origine. Ça évite l'effet « découpé aux ciseaux »
 * tout en gardant les cheveux et bords fins.
 *  - passes : nombre de floutages légers (0 = aucun)
 *  - seuilBas / seuilHaut : les valeurs de masque < seuilBas deviennent 0 et
 *    > seuilHaut deviennent 1 (supprime le bruit et les halos très faibles)
 */
export const ADOUCISSEMENT = { passes: 1, seuilBas: 0.04, seuilHaut: 0.96 };

// ---------------------------------------------------------------------------
// Modèles d'IA (tous à licence libre autorisant l'usage commercial)
// ---------------------------------------------------------------------------

/**
 * Chaque modèle décrit :
 *  - depot        : identifiant Hugging Face (téléchargé une seule fois puis mis en cache par le navigateur)
 *  - cote         : taille du carré d'entrée du réseau (1024 pour BiRefNet)
 *                   ou surface cible en pixels² pour les réseaux à taille libre (MODNet)
 *  - moyenne/ecartType : normalisation attendue par le réseau
 *  - dtypes       : formats de poids à essayer, dans l'ordre, selon le moteur
 *                   (fp16 = léger et rapide sur WebGPU, q8 = quantifié 8 bits, léger pour le WASM, fp32 = précis)
 */
export const MODELES = {
  birefnet: {
    id: 'birefnet',
    nom: 'BiRefNet lite',
    depot: 'onnx-community/BiRefNet_lite',
    taille: { mode: 'carre', cote: 1024 },
    moyenne: [0.485, 0.456, 0.406],
    ecartType: [0.229, 0.224, 0.225],
    // WebGPU uniquement. Mesuré : en WebAssembly, l'inférence 1024×1024 épuise la mémoire
    // (« std::bad_alloc », le WASM est limité à ~4 Go) après un téléchargement de ~200 Mo.
    // Sans WebGPU, l'application utilise donc MODNet. Liste vide = moteur non pris en charge.
    dtypes: { webgpu: ['fp16', 'fp32'], wasm: [] },
  },
  modnet: {
    id: 'modnet',
    nom: 'MODNet',
    depot: 'Xenova/modnet',
    taille: { mode: 'surface', surface: 512 * 512, multiple: 32 },
    moyenne: [0.5, 0.5, 0.5],
    ecartType: [0.5, 0.5, 0.5],
    dtypes: { webgpu: ['fp32'], wasm: ['fp32', 'q8'] },
  },
};

/** Vrai uniquement quand l'application est lancée en mode « test » (npm run test:e2e), jamais en production. */
export const MODE_TEST = import.meta.env.MODE === 'test';

if (MODE_TEST) {
  // Petit modèle libre (U²-Net-p, Apache-2.0) servi localement par les tests,
  // pour vérifier toute la chaîne sans dépendre de Hugging Face.
  MODELES.test = {
    id: 'test',
    nom: 'U²-Net-p (test)',
    depot: 'test/u2netp',
    taille: { mode: 'carre', cote: 320 },
    moyenne: [0.485, 0.456, 0.406],
    ecartType: [0.229, 0.224, 0.225],
    dtypes: { webgpu: ['fp32'], wasm: ['fp32'] },
  };
}

/** Dossier (relatif à la racine du site) des fichiers du runtime ONNX auto-hébergés. */
export const DOSSIER_ORT = 'ort/';
