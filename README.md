# Détoure — supprimer l'arrière-plan d'une image, 100 % dans le navigateur

Application web **gratuite** de suppression d'arrière-plan (type remove.bg) :

- l'IA tourne **dans le navigateur** de l'utilisateur : ni serveur, ni compte, ni clé d'API, ni base de données ;
- **« Vos images ne quittent jamais votre appareil »** : seul le modèle d'IA est téléchargé, jamais les photos ;
- export **PNG transparent en haute définition** (résolution d'origine, jusqu'à ~20 Mpx et plus) ;
- interface **en français**, mobile d'abord, mode sombre automatique ;
- **PWA installable**, utilisable **hors ligne** après la première utilisation ;
- hébergement gratuit sur Cloudflare Pages ou GitHub Pages.

## Fonctionnalités

| | |
|---|---|
| Dépôt d'images | glisser-déposer, bouton « Choisir une image », coller (Ctrl+V), **appareil photo sur mobile**. JPG, PNG, WEBP. |
| Plusieurs images | file d'attente traitée à la suite, statut par image, **téléchargement groupé en .zip**. |
| Avant / après | curseur de comparaison (souris, toucher, clavier) sur fond en damier. |
| Fonds | transparent, blanc ou **couleur unie** (sélecteur de couleur). |
| Première utilisation | barre de progression pendant le téléchargement du modèle, puis mise en cache par le navigateur. |
| Grandes images | décodage, IA, découpe et export dans un **Web Worker** avec `OffscreenCanvas` : l'interface ne se fige jamais. |
| Erreurs | messages clairs en français (format, fichier corrompu, mémoire, réseau…) et bouton « Réessayer ». |

## Installation et lancement sur votre PC

**Prérequis :** [Node.js](https://nodejs.org) version **22 LTS** (ou 20.19+). Vérifiez avec `node -v`.

```bash
# 1. Installer les dépendances (une seule fois)
npm install

# 2. Lancer le serveur de développement
npm run dev
```

Ouvrez ensuite **http://localhost:5173** dans Chrome, Edge, Firefox ou Safari.

> **Première image :** l'application télécharge le modèle d'IA depuis Hugging Face (plusieurs dizaines
> de Mo, jusqu'à ~200 Mo selon le format). La barre de progression l'indique. Ensuite le modèle reste
> dans le cache du navigateur et l'application fonctionne sans internet.

## Construire la version de production

```bash
npm run build      # crée le dossier dist/ (le site complet, ~41 Mo dont ~39 Mo de moteur ONNX)
npm run preview    # (facultatif) teste ce dossier dist/ sur http://localhost:4173
```

Le dossier `dist/` est un site statique : il suffit de le mettre en ligne. Les chemins sont relatifs,
le même build fonctionne à la racine d'un domaine **et** dans un sous-dossier (GitHub Pages).

## Mettre en ligne gratuitement

### Option A — Cloudflare Pages (la plus simple, sans Git)

1. Créez un compte gratuit sur <https://dash.cloudflare.com/sign-up> (aucune carte bancaire requise).
2. Sur votre PC : `npm install` puis `npm run build`. Un dossier `dist/` apparaît.
3. Dans le tableau de bord Cloudflare : **Workers & Pages → Create → Pages → Upload assets**.
4. Donnez un nom au projet (ex. `detoure`), cliquez **Create project**, puis **glissez le dossier `dist`**
   dans la zone d'envoi et cliquez **Deploy site**.
5. Au bout de quelques secondes, votre site est en ligne à l'adresse `https://detoure.pages.dev`
   (le nom dépend de votre projet). Pour le mettre à jour : refaites `npm run build` et un nouveau
   déploiement (**Create deployment** dans le projet).

*Variante avec Git (déploiement automatique à chaque `git push`)* : **Workers & Pages → Create → Pages →
Connect to Git**, choisissez votre dépôt GitHub, puis :

| Champ | Valeur |
|---|---|
| Framework preset | *None* |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Variable d'environnement | `NODE_VERSION` = `22` |

> Le moteur ONNX (fichier `.wasm` de ~27 Mo) est volontairement **découpé en morceaux de 10 Mo** au moment
> du build, car Cloudflare Pages refuse les fichiers de plus de 25 Mo. Le worker les réassemble.
> Vous n'avez rien à faire.

### Option B — GitHub Pages (automatique avec GitHub Actions)

1. Créez un compte gratuit sur <https://github.com> et un dépôt (public : GitHub Pages est gratuit).
2. Envoyez le projet sur la branche **`main`** :
   ```bash
   git init
   git add .
   git commit -m "Détoure"
   git branch -M main
   git remote add origin https://github.com/VOTRE-COMPTE/VOTRE-DEPOT.git
   git push -u origin main
   ```
3. Sur GitHub : **Settings → Pages → Build and deployment → Source : « GitHub Actions »**.
4. Le fichier `.github/workflows/deploy-pages.yml` (déjà fourni) construit et publie le site à chaque
   push sur `main`. Suivez la progression dans l'onglet **Actions**.
5. Votre site est en ligne à l'adresse `https://VOTRE-COMPTE.github.io/VOTRE-DEPOT/`.

### Vérifier après la mise en ligne

1. Ouvrez l'adresse (HTTPS obligatoire pour la PWA, c'est automatique chez les deux hébergeurs).
2. Traitez une image : le modèle se télécharge (barre de progression).
3. Passez en mode avion et rechargez : l'application s'ouvre et traite une nouvelle image **sans internet**.
4. Sur Chrome/Edge/Android : bouton **Installer** dans l'en-tête ; sur iPhone : Partager → **Sur l'écran d'accueil**.

## Comment ça marche

```
Image d'origine (ex. 5472×3648)
   │  ① décodée dans le worker (orientation EXIF respectée)
   ├─► version réduite 1024×1024 ──► ② BiRefNet lite (WebGPU, sinon WASM) ──► masque 1024×1024
   │                                                                           │
   │                                       ③ adoucissement léger des contours (feathering)
   │                                                                           │
   └─► ④ image d'origine INTACTE, masque agrandi à 5472×3648 appliqué dessus (« destination-in ») ──► PNG HD
```

L'IA ne voit qu'une version réduite, mais **la photo elle-même n'est jamais rééchantillonnée** : les
pixels opaques du PNG sont identiques à ceux de l'original (vérifié par les tests). Seules les
images dépassant 40 Mpx (16 Mpx sur iPhone/iPad, limite de canvas de Safari) sont réduites, avec un
avertissement affiché.

### Structure du projet

```
index.html               page unique : accueil, espace de travail et page « À propos »
src/
  main.js                interface : dépôt, file d'attente, comparateur, options, téléchargements, PWA
  config.js              ★ réglages : formats, limites, modèles d'IA, adoucissement des contours
  style.css              styles (mobile d'abord, mode sombre)
  ui/                    comparateur avant/après, liste des images
  lib/                   client du worker, erreurs en français, formats d'affichage, générateur .zip
  workers/
    segment.worker.js    Web Worker : orchestre tout le traitement
    modele.js            chargement du modèle + repli automatique (WebGPU→WASM, BiRefNet→MODNet)
    candidats.js         ordre d'essai des modèles (fonction pure, testée)
    imagerie.js          décodage, masque, adoucissement, découpe HD, aperçus (OffscreenCanvas)
    ort-loader.js        moteur ONNX Runtime auto-hébergé (pas de CDN externe)
public/                  manifeste PWA, icônes, en-têtes Cloudflare
scripts/
  prepare-ort.mjs        copie et découpe le moteur ONNX dans public/ort/ (lancé par dev et build)
  sw.template.js         modèle du service worker (hors ligne), finalisé par vite.config.js
tests/                   tests unitaires et de bout en bout (voir tests/README.md)
```

### Personnaliser

Tout se règle dans [`src/config.js`](src/config.js) : taille d'entrée du modèle, formats de poids essayés
(`fp16`, `q8`, `fp32`), force de l'adoucissement (`ADOUCISSEMENT`), limites de pixels et de poids des fichiers.

## Modèles d'IA et licences

| Élément | Rôle | Licence |
|---|---|---|
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), export ONNX [`onnx-community/BiRefNet_lite`](https://huggingface.co/onnx-community/BiRefNet_lite) | modèle principal | **MIT** |
| [MODNet](https://github.com/ZHKKKe/MODNet), export ONNX [`Xenova/modnet`](https://huggingface.co/Xenova/modnet) | repli rapide, portraits | **Apache 2.0** |
| [Transformers.js](https://github.com/huggingface/transformers.js) | exécution dans le navigateur | Apache 2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | moteur WebGPU / WASM | MIT |
| [Vite](https://vite.dev) | outil de build | MIT |

Ces licences permettent l'usage gratuit **et commercial**. Le modèle **RMBG de BRIA n'est volontairement
pas utilisé** (licence non commerciale).

> ⚠️ Licences relevées dans les dépôts d'origine (BiRefNet : `LICENSE` MIT ; MODNet : « code, modèles et démos » sous
> Apache 2.0). **Vérifiez aussi la fiche de chaque modèle sur Hugging Face** avant un usage commercial
> important : elle fait foi pour le fichier ONNX que vous téléchargez.

La page « À propos » de l'application reprend ces informations pour vos utilisateurs.

## Choix du modèle par l'utilisateur

Dans **Réglages** (page d'accueil) : *Automatique* (BiRefNet lite, puis MODNet si BiRefNet ne démarre pas),
*Précis* (BiRefNet seul) ou *Rapide* (MODNet seul : plus léger, idéal pour portraits ou téléphones lents).

## Compatibilité

- **Chrome / Edge (ordinateur et Android)** : WebGPU (rapide) ou WASM.
- **Firefox, Safari** : WebGPU selon la version, sinon WASM (plus lent : compter de quelques secondes à
  plus d'une minute par image sur téléphone). Le mode *Rapide* est conseillé sur les appareils modestes.
- Le WASM tourne sur un seul cœur : les hébergeurs gratuits n'autorisent pas les en-têtes nécessaires au
  multi-thread (`COOP/COEP`).

## Dépannage

| Symptôme | Piste |
|---|---|
| « Le modèle d'IA n'a pas pu démarrer sur cet appareil » | Ouvrez **Détails techniques** dans le message d'erreur : chaque tentative (modèle, moteur, format) y est listée avec sa cause. Le bouton **Copier les détails** facilite le signalement d'un problème. |
| « Impossible de télécharger le modèle d'IA » | Connexion coupée ou Hugging Face inaccessible (réseau d'entreprise, pare-feu). Réessayez ; vérifiez que `huggingface.co` est joignable. |
| « pas assez de mémoire » | Fermez d'autres onglets, essayez le mode *Rapide* ou une image plus petite. Les iPhone anciens ont peu de mémoire. |
| Très lent, sans WebGPU | Normal en WASM. Utilisez Chrome/Edge sur ordinateur ou le mode *Rapide*. |
| Site non mis à jour après un déploiement | Un bandeau « Nouvelle version disponible » apparaît : cliquez sur **Mettre à jour**. |
| `npm install` bloque sur `onnxruntime-node` | Le fichier `.npmrc` du projet ignore déjà les scripts d'installation ; supprimez `node_modules` et relancez `npm install`. |

## Tests

```bash
npm test
```

Voir [`tests/README.md`](tests/README.md) : 29 tests (unitaires + navigateur réel), dont une image de 20 Mpx,
le hors-ligne réel et la simulation des URL de production. Les tests n'utilisent **pas** BiRefNet/MODNet
(réseau bloqué en environnement automatisé) mais un petit modèle libre de substitution ; la qualité réelle
de détourage se juge à la main, avec vos propres photos.
