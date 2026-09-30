/**
 * Côté page : pilote le Web Worker (démarrage, envoi des tâches, réception des résultats).
 * Une seule tâche à la fois côté worker ; ici on garde juste la correspondance id → promesse.
 */
import { PIXELS_MAX, PIXELS_MAX_IOS } from '../config.js';
import { ErreurDetourage } from './erreurs.js';

/** Détecte iPhone/iPad (y compris iPadOS qui se fait passer pour un Mac). */
function estIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Variante du runtime ONNX à charger. Reproduit le choix de Transformers.js :
 * la version « asyncify » partout, sauf Safari < 26 sans WebGPU (version simple).
 */
function varianteOrt() {
  const ua = navigator.userAgent;
  const safari =
    (navigator.vendor || '').includes('Apple') &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i.test(ua) &&
    !ua.includes('Chrome') &&
    !ua.includes('Android');
  const version = ua.match(/Version\/(\d+)/);
  const ancien = safari && version && parseInt(version[1], 10) < 26;
  return ancien && !('gpu' in navigator) ? 'ort-wasm-simd-threaded' : 'ort-wasm-simd-threaded.asyncify';
}

/** Nombre maximal de worker successifs essayés pour une même image (un par candidat modèle/moteur). */
const MAX_REDEMARRAGES = 6;

export class Moteur {
  #worker = null;
  #taches = new Map(); // id → { resolve, reject, surEtat, surModele, surModelePret }
  #prochainId = 1;
  /** Mémoire des combinaisons modèle/moteur qui ont échoué : inutile de les retenter à l'image suivante. */
  #memoire = null;

  /** Contexte transmis au worker avec chaque image. */
  #contexte(preference) {
    return {
      racine: new URL('./', location.href).href,
      variante: varianteOrt(),
      preference,
      pixelsMax: estIOS() ? PIXELS_MAX_IOS : PIXELS_MAX,
    };
  }

  #demarrer() {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('../workers/segment.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => this.#recevoir(data);
    // Le worker a planté (souvent : plus de mémoire) : on rejette les tâches en attente et on le recréera.
    const planter = (detail) => {
      console.error('[worker] arrêt inattendu', detail);
      worker.terminate();
      this.#worker = null;
      for (const tache of this.#taches.values()) tache.reject(new ErreurDetourage('memoire', String(detail)));
      this.#taches.clear();
    };
    worker.onerror = (e) => planter(e?.message ?? 'erreur du worker');
    worker.onmessageerror = () => planter('message illisible');
    this.#worker = worker;
    return worker;
  }

  #recevoir(message) {
    const tache = this.#taches.get(message.id);
    if (!tache) return;
    switch (message.type) {
      case 'etat':
        tache.surEtat?.(message.etape);
        break;
      case 'modele':
        tache.surModele?.({ loaded: message.loaded, total: message.total });
        break;
      case 'modele-pret':
        tache.surModelePret?.(message);
        break;
      case 'termine':
        this.#taches.delete(message.id);
        this.#memoire = message.etat ?? null;
        tache.resolve(message.resultat);
        break;
      case 'fond-pret':
        this.#taches.delete(message.id);
        tache.resolve(message.blob);
        break;
      case 'erreur':
        this.#taches.delete(message.id);
        tache.reject(new ErreurDetourage(message.code, message.detail, message.etat));
        break;
    }
  }

  #envoyer(message, gestionnaires) {
    const id = this.#prochainId++;
    return new Promise((resolve, reject) => {
      this.#taches.set(id, { resolve, reject, ...gestionnaires });
      try {
        this.#demarrer().postMessage({ ...message, id });
      } catch (erreur) {
        this.#taches.delete(id);
        reject(new ErreurDetourage('navigateur', String(erreur?.message ?? erreur)));
      }
    });
  }

  /** Arrête le worker courant : le suivant démarre avec un moteur ONNX tout neuf. */
  #redemarrer() {
    this.#worker?.terminate();
    this.#worker = null;
  }

  /**
   * Supprime l'arrière-plan d'un fichier image. Renvoie les blobs (PNG HD + aperçus) et des infos.
   *
   * Si le moteur ONNX échoue (mémoire épuisée…), le worker demande un « redémarrage » : on le
   * remplace par un neuf et on relance avec le candidat suivant, en lui transmettant les échecs.
   */
  async traiter(fichier, { preference = 'auto', surEtat, surModele, surModelePret } = {}) {
    const gestionnaires = { surEtat, surModele, surModelePret };
    let etat = this.#memoire;
    for (let essai = 0; essai < MAX_REDEMARRAGES; essai++) {
      const contexte = { ...this.#contexte(preference), etat };
      try {
        return await this.#envoyer({ type: 'traiter', fichier, contexte }, gestionnaires);
      } catch (erreur) {
        if (erreur?.code !== 'redemarrage') {
          this.#memoire = null; // échec définitif : un nouvel essai manuel repart de zéro
          throw erreur;
        }
        etat = erreur.etat;
        this.#memoire = etat;
        this.#redemarrer();
        surEtat?.('redemarrage');
      }
    }
    this.#memoire = null;
    throw new ErreurDetourage('modele-indisponible', 'Trop de redémarrages successifs du moteur');
  }

  /** Compose le PNG transparent sur un fond uni (renvoie un PNG opaque en pleine résolution). */
  ajouterFond(blob, couleur) {
    return this.#envoyer({ type: 'fond', blob, couleur });
  }
}
