/**
 * Web Worker : tout le travail lourd (décodage, IA, découpe, encodage PNG) se fait ici,
 * pour ne jamais bloquer l'interface.
 *
 * Messages reçus  : { type: 'traiter', id, fichier, contexte } | { type: 'fond', id, blob, couleur }
 * Messages émis   : 'etat' (étape en cours), 'modele' (progression du téléchargement),
 *                   'modele-pret', 'termine', 'fond-pret', 'erreur'
 */
import { PIXELS_MAX } from '../config.js';
import { ErreurDetourage, estErreurMemoire } from '../lib/erreurs.js';
import { inferer } from './modele.js';
import { preparerOrt } from './ort-loader.js';
import {
  adoucirMasque,
  canvasDuMasque,
  composerSurFond,
  creerApercus,
  decoder,
  decouper,
  preparerEntree,
  verifierSupport,
  versMasque,
  versPng,
} from './imagerie.js';

const poster = (message, transferables) => self.postMessage(message, transferables);

// Les tâches sont exécutées une par une, dans l'ordre d'arrivée.
let file = Promise.resolve();
self.onmessage = ({ data }) => {
  file = file.then(() => executer(data)).catch(() => {});
};

async function executer(demande) {
  try {
    verifierSupport();
    if (demande.type === 'traiter') await traiter(demande);
    else if (demande.type === 'fond') await ajouterFond(demande);
  } catch (erreur) {
    const e =
      erreur instanceof ErreurDetourage
        ? erreur
        : new ErreurDetourage(estErreurMemoire(erreur) ? 'memoire' : 'inconnue', String(erreur?.message ?? erreur));
    console.error('[worker]', e.code, e.detail || e);
    poster({ type: 'erreur', id: demande.id, code: e.code, detail: e.detail });
  }
}

async function traiter({ id, fichier, contexte }) {
  const debut = performance.now();
  const etat = (etape) => poster({ type: 'etat', id, etape });
  const { racine, variante, preference, pixelsMax = PIXELS_MAX } = contexte;

  // 1. Décodage de l'image (orientation EXIF respectée)
  etat('lecture');
  const image = await decoder(fichier, pixelsMax);
  try {
    // 2. Moteur ONNX auto-hébergé + modèle (téléchargé une seule fois, puis en cache)
    etat('modele');
    await preparerOrt(racine, variante);

    // 3. Inférence sur la version réduite de l'image
    let analyse = false;
    const resultatIA = await inferer({
      preference,
      racine,
      onProgression: (p) => poster({ type: 'modele', id, ...p }),
      preparerEntree: (modeleCharge) => {
        if (!analyse) {
          analyse = true;
          poster({ type: 'modele-pret', id, modele: modeleCharge.config.nom, moteur: modeleCharge.moteur, dtype: modeleCharge.dtype });
          etat('analyse');
        }
        return preparerEntree(image.bitmap, modeleCharge.config);
      },
    });
    const { modele } = resultatIA;

    // 4. Masque : sigmoïde éventuelle, adoucissement des contours, agrandissement
    etat('decoupe');
    const masque = versMasque(resultatIA.masque);
    const alpha = adoucirMasque(masque, resultatIA.largeur, resultatIA.hauteur);
    const canvasMasque = canvasDuMasque(alpha, resultatIA.largeur, resultatIA.hauteur);

    // 5. Application du masque sur l'image d'origine en pleine résolution
    const canvasResultat = decouper(image.bitmap, canvasMasque);

    // 6. Export PNG transparent + aperçus légers pour l'écran
    etat('export');
    const [png, apercus] = await Promise.all([versPng(canvasResultat), creerApercus(image.bitmap, canvasResultat)]);

    poster({
      type: 'termine',
      id,
      resultat: {
        png,
        apercuAvant: apercus.avant,
        apercuApres: apercus.apres,
        largeur: image.largeur,
        hauteur: image.hauteur,
        largeurOrigine: image.largeurOrigine,
        hauteurOrigine: image.hauteurOrigine,
        reduite: image.reduite,
        modele: modele.config.nom,
        moteur: modele.moteur,
        dtype: modele.dtype,
        duree: performance.now() - debut,
      },
    });
  } finally {
    image.bitmap.close();
  }
}

async function ajouterFond({ id, blob, couleur }) {
  const png = await composerSurFond(blob, couleur);
  poster({ type: 'fond-pret', id, blob: png });
}
