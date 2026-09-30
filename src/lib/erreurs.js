/**
 * Erreurs de l'application, avec des messages clairs en français.
 * Le worker lève des `ErreurDetourage` avec un « code » ; l'interface affiche le message associé.
 */

const MESSAGES = {
  format:
    'Format non pris en charge. Choisissez une image JPG, PNG ou WEBP.',
  'trop-lourd':
    'Ce fichier est trop volumineux (60 Mo maximum). Essayez une version plus légère de l’image.',
  lecture:
    'Impossible de lire cette image. Elle est peut-être corrompue ou dans un format inhabituel. Essayez de l’enregistrer à nouveau en JPG ou PNG.',
  memoire:
    'Votre appareil n’a pas assez de mémoire pour traiter cette image. Fermez d’autres onglets ou applications, ou essayez une image plus petite.',
  'modele-reseau':
    'Impossible de télécharger le modèle d’IA. Vérifiez votre connexion internet puis réessayez. Après un premier téléchargement réussi, l’application fonctionne hors ligne.',
  'modele-indisponible':
    'Le modèle d’IA n’a pas pu démarrer sur cet appareil. Essayez le mode « Rapide » dans les réglages, ou un navigateur récent (Chrome, Edge, Firefox, Safari à jour).',
  'webgpu-requis':
    'Le mode « Précis » (BiRefNet) nécessite WebGPU, qui n’est pas disponible sur cet appareil. Utilisez le mode « Automatique » ou « Rapide », ou activez l’accélération matérielle de votre navigateur (Chrome : Paramètres → Système, puis vérifiez chrome://gpu).',
  navigateur:
    'Votre navigateur est trop ancien pour cette application. Mettez-le à jour ou utilisez Chrome, Edge, Firefox ou Safari récents.',
  inconnue:
    'Une erreur inattendue est survenue pendant le traitement. Réessayez ; si le problème persiste, rechargez la page.',
};

export class ErreurDetourage extends Error {
  /**
   * @param {string} code      identifiant court de l'erreur (« redemarrage » = relancer dans un worker neuf)
   * @param {string} [detail]  détail technique (affiché dans « Détails techniques »)
   * @param {object} [etat]    mémoire des échecs à transmettre au worker suivant (code « redemarrage »)
   */
  constructor(code, detail = '', etat = undefined) {
    super(detail || code);
    this.name = 'ErreurDetourage';
    this.code = code === 'redemarrage' || code in MESSAGES ? code : 'inconnue';
    this.detail = detail;
    this.etat = etat;
  }
}

/** Retourne le message français correspondant à un code d'erreur. */
export function messagePourCode(code) {
  return MESSAGES[code] ?? MESSAGES.inconnue;
}

/** Devine si une exception ressemble à un problème de mémoire. */
export function estErreurMemoire(erreur) {
  const texte = `${erreur?.name ?? ''} ${erreur?.message ?? ''}`.toLowerCase();
  return /out of memory|memory|allocation|rangeerror|oom|bad_alloc|too large|invalid array length/.test(texte);
}

/** Devine si une exception ressemble à un problème réseau (hors ligne, DNS, coupure…). */
export function estErreurReseau(erreur) {
  const texte = `${erreur?.name ?? ''} ${erreur?.message ?? ''}`.toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|network request failed|err_internet|offline/.test(texte);
}
