/**
 * Service worker de Détoure (rendu hors ligne).
 * Ce fichier est un MODÈLE : `vite build` remplace les trois marqueurs entourés de
 * doubles tirets bas (version, version du runtime ONNX, liste des fichiers) puis l'écrit
 * dans dist/sw.js (voir vite.config.js).
 *
 *  - Les fichiers de l'application (HTML, JS, CSS, icônes) sont mis en cache à l'installation.
 *  - Le runtime ONNX (dossier ort/, ~40 Mo) est mis en cache à la première utilisation.
 *  - Le modèle d'IA (Hugging Face) n'est PAS géré ici : Transformers.js le range lui-même
 *    dans le Cache API du navigateur ; ce service worker ne touche pas aux requêtes externes.
 */
const VERSION = '__VERSION__';
const CACHE_APP = `detoure-app-${VERSION}`;
const CACHE_ORT = `detoure-ort-__VERSION_ORT__`;
const FICHIERS = __FICHIERS__;

// Nos fichiers sont statiques : on ignore les paramètres d'URL et l'en-tête « Vary ».
// (Sans ignoreVary, un « Vary: Origin » ajouté par certains hébergeurs empêcherait de retrouver
// en cache un script de module demandé avec un en-tête Origin, et la page hors ligne resterait blanche.)
const OPTIONS_CORRESPONDANCE = { ignoreSearch: true, ignoreVary: true };

// Racine du site = dossier où se trouve sw.js (fonctionne aussi dans un sous-dossier, ex. GitHub Pages).
const RACINE = new URL('./', self.location).href;

/** Une réponse « redirigée » ne peut pas servir une navigation : on la recopie proprement. */
async function nettoyer(reponse) {
  if (!reponse.redirected) return reponse;
  return new Response(await reponse.blob(), { status: reponse.status, statusText: reponse.statusText, headers: reponse.headers });
}

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_APP);
      await Promise.all(
        FICHIERS.map(async (chemin) => {
          const url = new URL(chemin, RACINE).href;
          const reponse = await fetch(new Request(url, { cache: 'reload' }));
          if (!reponse.ok) throw new Error(`Précache impossible : ${chemin} (HTTP ${reponse.status})`);
          await cache.put(url, await nettoyer(reponse));
        }),
      );
      // Pas de skipWaiting automatique : la page propose la mise à jour à l'utilisateur.
    })(),
  );
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    (async () => {
      const gardes = new Set([CACHE_APP, CACHE_ORT]);
      for (const nom of await caches.keys()) {
        if (nom.startsWith('detoure-') && !gardes.has(nom)) await caches.delete(nom);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (evenement) => {
  if (evenement.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;
  if (requete.method !== 'GET') return;
  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return; // requêtes externes : on ne s'en mêle pas

  if (url.href.startsWith(`${RACINE}ort/`)) {
    evenement.respondWith(cachePuisReseau(CACHE_ORT, requete));
  } else {
    evenement.respondWith(applicationHorsLigne(requete));
  }
});

/** Runtime ONNX : cache d'abord, sinon réseau puis mise en cache. */
async function cachePuisReseau(nomCache, requete) {
  const cache = await caches.open(nomCache);
  const enCache = await cache.match(requete, OPTIONS_CORRESPONDANCE);
  if (enCache) return enCache;
  const reponse = await fetch(requete);
  if (reponse.ok) cache.put(requete, reponse.clone());
  return reponse;
}

/** Fichiers de l'application : cache d'abord (rapide + hors ligne), sinon réseau. */
async function applicationHorsLigne(requete) {
  const cache = await caches.open(CACHE_APP);
  const enCache = await cache.match(requete, OPTIONS_CORRESPONDANCE);
  if (enCache) return enCache;
  try {
    return await fetch(requete);
  } catch (erreur) {
    // Navigation hors ligne vers une adresse inconnue : on renvoie la page d'accueil.
    if (requete.mode === 'navigate') {
      const accueil = (await cache.match(RACINE)) ?? (await cache.match(`${RACINE}index.html`));
      if (accueil) return accueil;
    }
    throw erreur;
  }
}
