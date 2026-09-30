# Tests

```bash
npm test            # tests unitaires + tests de bout en bout
npm run test:unit   # fonctions pures uniquement (quelques secondes, sans navigateur)
npm run test:e2e    # application complète dans un vrai Chromium (~2 minutes)
```

## Prérequis pour les tests de bout en bout

Un navigateur Chromium pour Playwright (une seule fois) :

```bash
npx playwright-core install chromium
```

Si Chromium est déjà installé ailleurs : `CHROME_PATH=/chemin/vers/chrome npm run test:e2e`.

## Comment ça marche

Les tests compilent l'application en **mode `test`** (`vite build --mode test`). Dans ce mode
uniquement, un petit modèle libre — **U²-Net-p** (Apache-2.0, 4,6 Mo) — remplace BiRefNet/MODNet et
est servi localement depuis `tests/fixtures/` (téléchargé automatiquement par
`tests/prepare-fixtures.mjs`, ignoré par git). C'est un vrai réseau de neurones : worker, ONNX
Runtime, masque, découpe HD, PNG, cache hors ligne et PWA sont donc réellement exécutés, sans
dépendre de Hugging Face. **Ce modèle n'existe pas dans la version de production.**

La suite compile aussi la **version de production** et simule Hugging Face (Playwright) pour vérifier les URL
de modèles demandées, l'ordre de repli, et la reprise après une panne mémoire du moteur. Pour cela, deux
micro-modèles ONNX de quelques centaines d'octets sont versionnés dans `tests/modeles-factices/` (un qui
fonctionne, un qui épuise la mémoire à l'inférence ; voir `creer.py`).

## Ce qui est vérifié

- Accueil, page « À propos » (licences), manifeste PWA, service worker et précache.
- Portrait : PNG transparent à la résolution d'origine, bords adoucis.
- **Image de 20 Mpx** : dimensions identiques, pixels opaques *strictement identiques* à l'original,
  interface jamais bloquée (mesure des images affichées pendant le traitement).
- Fond blanc / couleur, noms de fichiers, comparateur (souris + clavier), « Nouvelle image ».
- Lot de plusieurs images + archive `.zip` valide (`unzip -t`).
- Messages d'erreur en français (format, fichier corrompu, réseau) et « Réessayer ».
- Barre de progression du téléchargement du modèle (connexion lente simulée).
- **Configuration de production** : sans WebGPU, MODNet seul (aucun téléchargement de BiRefNet) ; mode Précis
  refusé sans téléchargement ; **panne mémoire du moteur → worker neuf → modèle suivant → image détourée**.
- **Hors ligne réel** : le serveur est arrêté, l'application se recharge et traite une image.
- Mobile 390 px / 360 px, pas de défilement horizontal, mode sombre.

Les images de `tests/images/` proviennent de la bibliothèque scikit-image
(domaine public / CC0 : astronaute NASA, chat, tasse de café, fusée NASA).

## Ce que ces tests ne peuvent PAS vérifier

- La qualité de détourage de BiRefNet lite et de MODNet (les modèles réels sont téléchargés depuis
  Hugging Face, hors de portée des tests automatiques) : à essayer à la main avec vos propres photos.
- Un GPU réel (WebGPU) : essayé uniquement avec un adaptateur logiciel de Chromium.
- Safari / iOS : à tester sur un iPhone après déploiement.
