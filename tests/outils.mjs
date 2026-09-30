/** Mini-lanceur de tests partagé (aucune dépendance) : assert, test, bilan. */
let reussis = 0;
const echecs = [];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function egal(obtenu, attendu, message = '') {
  const a = JSON.stringify(obtenu);
  const b = JSON.stringify(attendu);
  if (a !== b) throw new Error(`${message}\n        attendu : ${b}\n        obtenu  : ${a}`);
}

export async function test(nom, fonction) {
  const debut = Date.now();
  try {
    await fonction();
    reussis++;
    console.log(`  ✓ ${nom}  (${((Date.now() - debut) / 1000).toFixed(1)} s)`);
  } catch (erreur) {
    echecs.push(nom);
    console.log(`  ✗ ${nom}\n      ${String(erreur?.stack ?? erreur).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

/** Affiche le bilan et renvoie le code de sortie à utiliser (0 = tout va bien). */
export function bilan() {
  console.log(`\n${reussis} test(s) réussi(s), ${echecs.length} échec(s)${echecs.length ? ` : ${echecs.join(' ; ')}` : ''}`);
  return echecs.length ? 1 : 0;
}
