/**
 * Ordre d'essai des « candidats » : combinaisons modèle × moteur × format de poids.
 * Fonction pure (aucun accès au navigateur) : elle est donc facilement testable.
 */
import { MODELES, ORDRE_MODELES } from '../config.js';

/**
 * @param {object} options
 * @param {string} options.preference                     'auto' | 'precis' | 'rapide'
 * @param {{ id: 'webgpu'|'wasm', fp16: boolean }[]} options.moteurs  moteurs utilisables, par ordre de préférence
 * @param {Set<string>} options.echecs                    combinaisons « modèle|moteur|dtype » déjà tombées en échec
 * @param {Set<string>} options.manquants                 fichiers absents du dépôt « modèle|dtype »
 * @returns {{ cle: string, config: object, moteur: string, dtype: string }[]}
 */
export function listerCandidats({ preference, moteurs, echecs, manquants }) {
  const liste = [];
  for (const idModele of ORDRE_MODELES[preference] ?? ORDRE_MODELES.auto) {
    const config = MODELES[idModele];
    for (const moteur of moteurs) {
      for (const dtype of config.dtypes[moteur.id]) {
        if (dtype === 'fp16' && !moteur.fp16) continue; // le GPU ne sait pas faire du fp16
        const cle = `${idModele}|${moteur.id}|${dtype}`;
        if (echecs.has(cle) || manquants.has(`${idModele}|${dtype}`)) continue;
        liste.push({ cle, config, moteur: moteur.id, dtype });
      }
    }
  }
  return liste;
}
