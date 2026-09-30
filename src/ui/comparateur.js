/**
 * Comparateur avant/après : deux images superposées, un curseur (input range natif,
 * donc accessible au clavier et au toucher) qui déplace la séparation.
 * Sous la partie « après », un damier montre la transparence (ou la couleur de fond choisie).
 */

/**
 * @param {{ urlAvant: string, urlApres: string, largeur: number, hauteur: number }} options
 * @returns {{ element: HTMLElement, definirFond: (fond: string | null) => void }}
 *          `fond` = null pour le damier (transparent), sinon une couleur CSS.
 */
export function creerComparateur({ urlAvant, urlApres, largeur, hauteur }) {
  const element = document.createElement('div');
  element.className = 'comparateur';
  element.style.setProperty('--ratio', String(largeur / hauteur));
  element.innerHTML = `
    <div class="fond damier"></div>
    <img class="apres" alt="Image sans arrière-plan" draggable="false" />
    <img class="avant" alt="Image d’origine" draggable="false" />
    <span class="etiquette g">Avant</span>
    <span class="etiquette d">Après</span>
    <input class="curseur" type="range" min="0" max="100" step="0.1" value="50"
           aria-label="Comparer l’image d’origine (à gauche) et le résultat (à droite)" />
    <div class="poignee"></div>`;
  element.querySelector('.avant').src = urlAvant;
  element.querySelector('.apres').src = urlApres;

  const curseur = element.querySelector('.curseur');
  curseur.addEventListener('input', () => element.style.setProperty('--pos', `${curseur.value}%`));

  const fondEl = element.querySelector('.fond');
  return {
    element,
    definirFond(couleur) {
      fondEl.classList.toggle('damier', couleur === null);
      fondEl.style.background = couleur ?? '';
    },
  };
}
