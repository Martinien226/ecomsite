/**
 * Télécharge le petit modèle de test (U²-Net-p, licence Apache-2.0, ~4,6 Mo) dans
 * tests/fixtures/, à l'endroit exact où l'application de test le cherchera.
 *
 * Pourquoi ? Les tests automatisés ne dépendent ainsi pas de Hugging Face : ils vérifient
 * TOUTE la chaîne (worker, ONNX Runtime, masque, découpe HD, PNG, cache hors ligne) avec un
 * vrai réseau de neurones. Ce modèle n'est jamais utilisé en production.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const dossier = join(racine, 'tests', 'fixtures', 'hf', 'test', 'u2netp', 'resolve', 'main');
const fichierModele = join(dossier, 'onnx', 'model.onnx');
const SOURCE = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx';

mkdirSync(join(dossier, 'onnx'), { recursive: true });
writeFileSync(join(dossier, 'config.json'), JSON.stringify({ model_type: 'u2net' }));

if (existsSync(fichierModele) && statSync(fichierModele).size > 1_000_000) {
  console.log('✓ Modèle de test déjà présent');
} else {
  console.log(`Téléchargement de ${SOURCE} …`);
  const reponse = await fetch(SOURCE);
  if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
  writeFileSync(fichierModele, Buffer.from(await reponse.arrayBuffer()));
  console.log(`✓ Modèle de test enregistré (${(statSync(fichierModele).size / 1e6).toFixed(1)} Mo)`);
}
