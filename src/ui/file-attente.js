/**
 * Liste des images à traiter (miniature, nom, statut). Un clic affiche le résultat.
 * Les lignes sont créées une fois et simplement mises à jour ensuite (pas de scintillement).
 */

const LIBELLES = {
  attente: 'En attente',
  encours: 'Traitement en cours…',
  ok: 'Terminé',
  erreur: 'Échec',
};

const VIGNETTE_VIDE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='52' height='52'%3E%3Crect width='52' height='52' fill='%23888' fill-opacity='.25'/%3E%3C/svg%3E";

export class FileAttente {
  #liste;
  #lignes = new Map(); // id → { li, bouton, img, nom, statut }
  #surChoix;

  /**
   * @param {HTMLElement} liste  le <ul> à remplir
   * @param {(id: number) => void} surChoix  appelé quand l'utilisateur choisit une image
   */
  constructor(liste, surChoix) {
    this.#liste = liste;
    this.#surChoix = surChoix;
  }

  /** Met la liste à jour à partir des éléments de l'état de l'application. */
  mettreAJour(elements, idSelection) {
    const presents = new Set(elements.map((e) => e.id));
    for (const [id, ligne] of this.#lignes) {
      if (!presents.has(id)) {
        ligne.li.remove();
        this.#lignes.delete(id);
      }
    }
    for (const el of elements) {
      let ligne = this.#lignes.get(el.id);
      if (!ligne) {
        ligne = this.#creerLigne(el);
        this.#lignes.set(el.id, ligne);
        this.#liste.append(ligne.li);
      }
      const src = el.urlApercu ?? el.urlOriginale ?? VIGNETTE_VIDE;
      if (ligne.img.getAttribute('src') !== src) ligne.img.src = src;
      ligne.statut.textContent = LIBELLES[el.statut];
      ligne.statut.className = `statut ${el.statut}`;
      ligne.bouton.setAttribute('aria-current', String(el.id === idSelection));
    }
  }

  #creerLigne(el) {
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="element">
        <img alt="" width="52" height="52" decoding="async" />
        <span class="infos"><span class="nom"></span><span class="statut"></span></span>
      </button>`;
    const bouton = li.querySelector('button');
    li.querySelector('.nom').textContent = el.fichier.name || 'image';
    bouton.addEventListener('click', () => this.#surChoix(el.id));
    return { li, bouton, img: li.querySelector('img'), statut: li.querySelector('.statut') };
  }
}
