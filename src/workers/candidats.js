/**
 * Ordre d'essai des « candidats » : combinaisons modèle × moteur × format de poids.
 * Fonctions pures (aucun accès au navigateur) : elles sont donc facilement testables.
 */
import { MODE_TEST, MODELES } from '../config.js';

/**
 * Quels modèles essayer, dans quel ordre ?
 *  - automatique : BiRefNet (précis) si WebGPU est disponible, sinon directement MODNet ;
 *                  MODNet sert aussi de repli si BiRefNet échoue ;
 *  - précis : BiRefNet seul (nécessite WebGPU) ;  - rapide : MODNet seul.
 * @param {'auto'|'precis'|'rapide'} preference
 * @param {boolean} webgpu  un adaptateur WebGPU est-il disponible ?
 */
export function ordreModeles(preference, webgpu) {
  if (MODE_TEST) return ['test'];
  if (preference === 'precis') return ['birefnet'];
  if (preference === 'rapide') return ['modnet'];
  return webgpu ? ['birefnet', 'modnet'] : ['modnet'];
}

/**
 * @param {object} options
 * @param {string} options.preference
 * @param {{ id: 'webgpu'|'wasm', fp16: boolean }[]} options.moteurs  moteurs utilisables, par ordre de préférence
 * @param {Set<string>} options.echecs                    combinaisons « modèle|moteur|dtype » déjà tombées en échec
 * @param {Set<string>} options.manquants                 fichiers absents du dépôt « modèle|dtype »
 * @returns {{ cle: string, config: object, moteur: string, dtype: string }[]}
 */
export function listerCandidats({ preference, moteurs, echecs, manquants }) {
  const webgpu = moteurs.some((m) => m.id === 'webgpu');
  const liste = [];
  for (const idModele of ordreModeles(preference, webgpu)) {
    const config = MODELES[idModele];
    for (const moteur of moteurs) {
      for (const dtype of config.dtypes[moteur.id] ?? []) {
        if (dtype === 'fp16' && !moteur.fp16) continue; // le GPU ne sait pas faire du fp16
        const cle = `${idModele}|${moteur.id}|${dtype}`;
        if (echecs.has(cle) || manquants.has(`${idModele}|${dtype}`)) continue;
        liste.push({ cle, config, moteur: moteur.id, dtype });
      }
    }
  }
  return liste;
}
