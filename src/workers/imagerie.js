/**
 * Traitement d'image dans le Web Worker (OffscreenCanvas) : décodage, préparation de
 * l'entrée du réseau, adoucissement du masque, application en PLEINE résolution.
 *
 * Principe HD : le réseau travaille sur une version réduite (ex. 1024×1024). Le masque
 * obtenu est ensuite agrandi à la taille d'origine et appliqué sur l'image d'origine
 * intacte : les pixels de la photo ne sont jamais rééchantillonnés ni compressés.
 */
import { ADOUCISSEMENT, APERCU_COTE_MAX } from '../config.js';
import { ErreurDetourage, estErreurMemoire } from '../lib/erreurs.js';

/** Vérifie que le navigateur sait faire ce dont on a besoin dans un worker. */
export function verifierSupport() {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new ErreurDetourage('navigateur', 'OffscreenCanvas / createImageBitmap indisponibles');
  }
}

/** Crée un canvas hors écran ; échoue proprement si la mémoire manque. */
function creerCanvas(largeur, hauteur, options) {
  try {
    const canvas = new OffscreenCanvas(largeur, hauteur);
    const contexte = canvas.getContext('2d', options);
    if (!contexte) throw new Error('contexte 2D indisponible');
    return { canvas, contexte };
  } catch (erreur) {
    throw new ErreurDetourage('memoire', `Canvas ${largeur}×${hauteur} : ${erreur?.message}`);
  }
}

/**
 * Décode l'image en tenant compte de l'orientation EXIF (photos de téléphone).
 * Si elle dépasse `pixelsMax`, elle est réduite (seul cas où la définition baisse).
 * @returns {Promise<{ bitmap: ImageBitmap, largeur: number, hauteur: number, reduite: boolean, largeurOrigine: number, hauteurOrigine: number }>}
 */
export async function decoder(blob, pixelsMax) {
  let bitmap;
  try {
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (erreur) {
      // Navigateur ancien qui ne connaît pas l'option d'orientation (TypeError) : on réessaie sans elle.
      if (!(erreur instanceof TypeError)) throw erreur;
      bitmap = await createImageBitmap(blob);
    }
  } catch (erreur) {
    throw new ErreurDetourage(estErreurMemoire(erreur) ? 'memoire' : 'lecture', String(erreur?.message ?? erreur));
  }
  const largeurOrigine = bitmap.width;
  const hauteurOrigine = bitmap.height;
  if (largeurOrigine * hauteurOrigine <= pixelsMax) {
    return { bitmap, largeur: largeurOrigine, hauteur: hauteurOrigine, reduite: false, largeurOrigine, hauteurOrigine };
  }

  // Trop grande pour cet appareil : réduction (proportions conservées).
  const echelle = Math.sqrt(pixelsMax / (largeurOrigine * hauteurOrigine));
  const largeur = Math.max(1, Math.floor(largeurOrigine * echelle));
  const hauteur = Math.max(1, Math.floor(hauteurOrigine * echelle));
  const { canvas, contexte } = creerCanvas(largeur, hauteur);
  contexte.imageSmoothingQuality = 'high';
  contexte.drawImage(bitmap, 0, 0, largeur, hauteur);
  bitmap.close();
  return { bitmap: await createImageBitmap(canvas), largeur, hauteur, reduite: true, largeurOrigine, hauteurOrigine };
}

/** Dimensions d'entrée du réseau selon la configuration du modèle. */
export function dimensionsEntree(taille, largeur, hauteur) {
  if (taille.mode === 'carre') return { w: taille.cote, h: taille.cote };
  // Réseau à taille libre (MODNet) : même surface, proportions conservées, multiples de `multiple`.
  const echelle = Math.sqrt(taille.surface / (largeur * hauteur));
  const arrondir = (v) => Math.max(taille.multiple, Math.round((v * echelle) / taille.multiple) * taille.multiple);
  return { w: arrondir(largeur), h: arrondir(hauteur) };
}

/**
 * Réduit l'image à la taille d'entrée du réseau et la convertit en tenseur NCHW normalisé.
 * Les zones transparentes (PNG) sont posées sur du blanc pour ne pas fausser l'analyse.
 */
export function preparerEntree(bitmap, config) {
  const { w, h } = dimensionsEntree(config.taille, bitmap.width, bitmap.height);
  const { contexte } = creerCanvas(w, h, { willReadFrequently: true });
  contexte.fillStyle = '#fff';
  contexte.fillRect(0, 0, w, h);
  contexte.imageSmoothingQuality = 'high';
  contexte.drawImage(bitmap, 0, 0, w, h);
  const pixels = contexte.getImageData(0, 0, w, h).data;

  const surface = w * h;
  const donnees = new Float32Array(3 * surface);
  const [m0, m1, m2] = config.moyenne;
  const [e0, e1, e2] = config.ecartType;
  for (let i = 0, p = 0; i < surface; i++, p += 4) {
    donnees[i] = (pixels[p] / 255 - m0) / e0;
    donnees[surface + i] = (pixels[p + 1] / 255 - m1) / e1;
    donnees[2 * surface + i] = (pixels[p + 2] / 255 - m2) / e2;
  }
  return { donnees, largeur: w, hauteur: h };
}

/**
 * Transforme la sortie brute du réseau en masque d'opacité entre 0 et 1.
 * Selon le modèle, la sortie est déjà une probabilité (MODNet) ou un « logit »
 * (BiRefNet) : on applique la sigmoïde seulement dans le second cas.
 */
export function versMasque(sortie) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < sortie.length; i++) {
    const v = sortie[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const estLogit = min < -0.01 || max > 1.01;
  const masque = new Float32Array(sortie.length);
  for (let i = 0; i < sortie.length; i++) {
    masque[i] = estLogit ? 1 / (1 + Math.exp(-sortie[i])) : Math.min(1, Math.max(0, sortie[i]));
  }
  return masque;
}

/**
 * Adoucit légèrement les contours du masque (noyau [1 2 1]/4 en horizontal puis en vertical),
 * puis resserre les niveaux pour supprimer le bruit. Les cheveux et bords fins restent nets
 * mais sans marches d'escalier.
 */
export function adoucirMasque(masque, largeur, hauteur) {
  const { passes, seuilBas, seuilHaut } = ADOUCISSEMENT;
  let courant = masque;
  let temporaire = new Float32Array(masque.length);
  for (let passe = 0; passe < passes; passe++) {
    // Horizontal
    for (let y = 0; y < hauteur; y++) {
      const ligne = y * largeur;
      for (let x = 0; x < largeur; x++) {
        const g = courant[ligne + (x > 0 ? x - 1 : x)];
        const d = courant[ligne + (x < largeur - 1 ? x + 1 : x)];
        temporaire[ligne + x] = (g + 2 * courant[ligne + x] + d) / 4;
      }
    }
    // Vertical
    const resultat = courant === masque ? new Float32Array(masque.length) : courant;
    for (let y = 0; y < hauteur; y++) {
      const haut = (y > 0 ? y - 1 : y) * largeur;
      const bas = (y < hauteur - 1 ? y + 1 : y) * largeur;
      const ligne = y * largeur;
      for (let x = 0; x < largeur; x++) {
        resultat[ligne + x] = (temporaire[haut + x] + 2 * temporaire[ligne + x] + temporaire[bas + x]) / 4;
      }
    }
    courant = resultat;
  }
  temporaire = null;

  const plage = Math.max(1e-6, seuilHaut - seuilBas);
  const final = new Uint8ClampedArray(courant.length);
  for (let i = 0; i < courant.length; i++) {
    final[i] = Math.round(Math.min(1, Math.max(0, (courant[i] - seuilBas) / plage)) * 255);
  }
  return final; // opacité 0-255
}

/** Dessine le masque (opacité) dans un petit canvas, prêt à être agrandi. */
export function canvasDuMasque(alpha, largeur, hauteur) {
  const { canvas, contexte } = creerCanvas(largeur, hauteur);
  const image = contexte.createImageData(largeur, hauteur);
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) image.data[p] = alpha[i];
  contexte.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Applique le masque sur l'image d'origine EN PLEINE RÉSOLUTION.
 * Le mode « destination-in » ne garde que les pixels d'origine là où le masque (agrandi
 * en douceur) est opaque : la photo elle-même n'est jamais modifiée. La transparence
 * éventuelle de l'image d'origine (PNG) est conservée.
 */
export function decouper(bitmap, canvasMasque) {
  const { canvas, contexte } = creerCanvas(bitmap.width, bitmap.height);
  contexte.drawImage(bitmap, 0, 0);
  contexte.globalCompositeOperation = 'destination-in';
  contexte.imageSmoothingEnabled = true;
  contexte.imageSmoothingQuality = 'high';
  contexte.drawImage(canvasMasque, 0, 0, bitmap.width, bitmap.height);
  return canvas;
}

/** Encode un canvas en PNG. */
export async function versPng(canvas) {
  try {
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch (erreur) {
    throw new ErreurDetourage(estErreurMemoire(erreur) ? 'memoire' : 'inconnue', `Encodage PNG : ${erreur?.message}`);
  }
}

/** Réduit une source (bitmap ou canvas) pour l'affichage, en conservant les proportions. */
async function reduire(source, type, qualite, fondBlanc) {
  const echelle = Math.min(1, APERCU_COTE_MAX / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * echelle));
  const h = Math.max(1, Math.round(source.height * echelle));
  const { canvas, contexte } = creerCanvas(w, h);
  if (fondBlanc) {
    contexte.fillStyle = '#fff';
    contexte.fillRect(0, 0, w, h);
  }
  contexte.imageSmoothingQuality = 'high';
  contexte.drawImage(source, 0, 0, w, h);
  return canvas.convertToBlob({ type, quality: qualite });
}

/** Aperçus légers (l'interface n'affiche jamais les images en pleine résolution : économie de mémoire). */
export async function creerApercus(bitmap, canvasResultat) {
  const [avant, apres] = await Promise.all([
    reduire(bitmap, 'image/jpeg', 0.92, true),
    reduire(canvasResultat, 'image/png', undefined, false),
  ]);
  return { avant, apres };
}

/** Pose le détourage PNG sur un fond uni et renvoie un PNG opaque en pleine résolution. */
export async function composerSurFond(blobPng, couleur) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blobPng);
  } catch (erreur) {
    throw new ErreurDetourage(estErreurMemoire(erreur) ? 'memoire' : 'lecture', String(erreur?.message));
  }
  const { canvas, contexte } = creerCanvas(bitmap.width, bitmap.height);
  contexte.fillStyle = couleur;
  contexte.fillRect(0, 0, bitmap.width, bitmap.height);
  contexte.drawImage(bitmap, 0, 0);
  bitmap.close();
  return versPng(canvas);
}
