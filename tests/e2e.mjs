/**
 * Tests de bout en bout : l'application est compilée en « mode test », servie localement
 * et pilotée dans un vrai Chromium (Playwright). Le modèle de test (U²-Net-p) est un vrai
 * réseau de neurones : toute la chaîne (worker, ONNX Runtime, masque, découpe HD, PNG, cache
 * hors ligne, PWA) est donc réellement exécutée.
 *
 * Lancer :  npm run test:e2e        (voir tests/README.md)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { assert, bilan, test } from './outils.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const images = (nom) => join(racine, 'tests', 'images', nom);
const sortie = join(racine, 'tests', 'out');
mkdirSync(sortie, { recursive: true });
process.chdir(racine);

// ---------------------------------------------------------------------------
// Serveur + navigateur
// ---------------------------------------------------------------------------

console.log('Compilation en mode test…');
await build({ mode: 'test', logLevel: 'warn', build: { outDir: 'dist-test' } });
const serveur = await preview({
  mode: 'test',
  logLevel: 'warn',
  build: { outDir: 'dist-test' },
  preview: { port: 4173, strictPort: false },
});
const URL_APP = serveur.resolvedUrls.local[0];
/**
 * Serveur dédié à un test hors ligne : on peut l'ARRÊTER pour de vrai (connexion refusée),
 * ce qui est bien plus fiable que la simulation « hors ligne » du navigateur, laquelle
 * n'affecte pas toujours les requêtes du service worker.
 */
function serveurArretable(port) {
  const demarrer = () => preview({ mode: 'test', logLevel: 'silent', build: { outDir: 'dist-test' }, preview: { port, strictPort: true } });
  let courant = null;
  return {
    url: `http://localhost:${port}/`,
    async demarrer() {
      courant = await demarrer();
    },
    async arreter() {
      courant.httpServer.closeAllConnections?.();
      await new Promise((ok) => courant.httpServer.close(ok));
    },
  };
}

const navigateur = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

/** Nouvelle « session » de navigation isolée (caches, service worker et stockage vierges). */
async function ouvrir(options = {}) {
  const contexte = await navigateur.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true, ...options });
  const page = await contexte.newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erreurs.push(`console.error: ${m.text()}`);
  });
  await page.goto(URL_APP);
  return { contexte, page, erreurs };
}

const attendreTermine = (page, nombre = 1, timeout = 120_000) =>
  page.waitForFunction((n) => document.querySelectorAll('.statut.ok').length >= n, nombre, { timeout });

/** Analyse un PNG (Buffer ou Blob de la page) : dimensions, répartition de l'opacité. */
const ANALYSE_PNG = async (source) => {
  const blob = typeof source === 'string' ? await (await fetch(`data:image/png;base64,${source}`)).blob() : source;
  const bitmap = await createImageBitmap(blob);
  const { width: w, height: h } = bitmap;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  let transparent = 0;
  let opaque = 0;
  let partiel = 0;
  let premier = null;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a === 0) {
      transparent++;
      premier ??= { x: i % w, y: Math.floor(i / w) };
    } else if (a === 255) opaque++;
    else partiel++;
  }
  const px = (x, y) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
  return { w, h, total: w * h, transparent, opaque, partiel, premier, pixelPremier: premier ? px(premier.x, premier.y) : null };
};
const analyserBuffer = (page, buffer) => page.evaluate(ANALYSE_PNG, buffer.toString('base64'));

/** Lit largeur/hauteur dans l'en-tête d'un PNG. */
function dimensionsPng(buffer) {
  assert(buffer.subarray(1, 4).toString() === 'PNG', 'le fichier téléchargé n’est pas un PNG');
  return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
}

async function telecharger(page, selecteur) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click(selecteur)]);
  const chemin = await dl.path();
  return { nom: dl.suggestedFilename(), buffer: readFileSync(chemin), chemin };
}

// ---------------------------------------------------------------------------
// Les tests
// ---------------------------------------------------------------------------

console.log('\nAccueil, À propos, PWA');
await test('page d’accueil : titre, message de confidentialité, zone de dépôt', async () => {
  const { contexte, page, erreurs } = await ouvrir();
  assert((await page.title()).includes('Détoure'), 'titre');
  assert(await page.getByRole('heading', { level: 1 }).innerText() === 'Supprimez l’arrière-plan de vos images', 'h1');
  assert(await page.getByText('Vos images ne quittent jamais votre appareil').first().isVisible(), 'message confidentialité');
  assert(await page.locator('#zone-depot').isVisible(), 'zone de dépôt');
  assert(await page.getByRole('button', { name: 'Choisir une image' }).isVisible(), 'bouton choisir');
  assert(erreurs.length === 0, `erreurs console : ${erreurs.join(' | ')}`);
  await contexte.close();
});

await test('page « À propos » : licences des modèles, navigation retour', async () => {
  const { contexte, page } = await ouvrir();
  await page.getByRole('link', { name: 'À propos' }).click();
  await page.waitForSelector('#vue-apropos:not([hidden])');
  const texte = await page.locator('#vue-apropos').innerText();
  for (const attendu of ['BiRefNet', 'MODNet', 'MIT', 'Apache 2.0', 'Transformers.js', 'RMBG']) assert(texte.includes(attendu), `« ${attendu} » manquant dans À propos`);
  assert(await page.locator('#vue-app').isHidden(), 'la vue principale doit être masquée');
  await page.getByRole('link', { name: '← Retour à l’application' }).click();
  await page.waitForSelector('#vue-app:not([hidden])');
  await contexte.close();
});

await test('PWA : manifeste valide, icônes, service worker actif et précache', async () => {
  const { contexte, page } = await ouvrir();
  const manifeste = await (await page.request.get(`${URL_APP}manifest.webmanifest`)).json();
  assert(manifeste.lang === 'fr' && manifeste.display === 'standalone', 'manifeste');
  assert(manifeste.icons.some((i) => i.purpose === 'maskable') && manifeste.icons.some((i) => i.sizes === '512x512'), 'icônes 512 + maskable');
  for (const icone of manifeste.icons) assert((await page.request.get(new URL(icone.src, URL_APP).href)).ok(), `icône ${icone.src}`);
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated');
  const etatSW = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { actif: reg.active?.state, portee: reg.scope };
  });
  assert(etatSW.actif === 'activated', `service worker ${etatSW.actif}`);
  const precache = await page.evaluate(async () => {
    const noms = (await caches.keys()).filter((n) => n.startsWith('detoure-app-'));
    return (await (await caches.open(noms[0])).keys()).map((r) => new URL(r.url).pathname);
  });
  assert(precache.includes('/') && precache.some((p) => p.endsWith('.js')) && precache.some((p) => p.endsWith('.css')), `précache incomplet : ${precache}`);
  await contexte.close();
});

console.log('\nDétourage d’une image');
let sessionPrincipale;
await test('portrait : PNG à la résolution d’origine, transparent avec bords adoucis', async () => {
  sessionPrincipale = await ouvrir();
  const { page, erreurs } = sessionPrincipale;
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page);
  const stats = await page.evaluate(async (analyse) => {
    const el = window.__detoure.etat.elements[0];
    return { ...(await eval(`(${analyse})`)(el.resultat.png)), reduite: el.resultat.reduite, moteur: el.resultat.moteur, modele: el.resultat.modele };
  }, ANALYSE_PNG.toString());
  console.log(`      ${stats.modele} · ${stats.moteur} · ${stats.w}×${stats.h} · transparent ${((stats.transparent / stats.total) * 100).toFixed(0)} % · opaque ${((stats.opaque / stats.total) * 100).toFixed(0)} % · bords adoucis ${((stats.partiel / stats.total) * 100).toFixed(1)} %`);
  assert(stats.w === 512 && stats.h === 512, `dimensions ${stats.w}×${stats.h}`);
  assert(stats.transparent / stats.total > 0.05, 'pas assez de pixels transparents');
  assert(stats.opaque / stats.total > 0.05, 'pas assez de pixels opaques');
  assert(stats.partiel / stats.total > 0.002, 'aucun bord adouci (feathering)');
  assert(!stats.reduite, 'ne doit pas être réduite');
  assert(await page.locator('.comparateur').isVisible(), 'comparateur visible');
  assert(erreurs.length === 0, `erreurs console : ${erreurs.join(' | ')}`);
  await page.screenshot({ path: join(sortie, 'bureau-portrait.png'), fullPage: true });
});

await test('téléchargement PNG transparent : nom de fichier et contenu', async () => {
  const { page } = sessionPrincipale;
  const { nom, buffer } = await telecharger(page, '#btn-telecharger');
  assert(nom === 'portrait-cheveux-sans-fond.png', `nom : ${nom}`);
  const { w, h } = dimensionsPng(buffer);
  assert(w === 512 && h === 512, `dimensions ${w}×${h}`);
  const stats = await analyserBuffer(page, buffer);
  assert(stats.transparent > 1000, 'le PNG téléchargé doit être transparent');
  sessionPrincipale.premierTransparent = stats.premier;
});

await test('fond blanc puis fond de couleur : PNG opaque, bon nom, bonne couleur', async () => {
  const { page } = sessionPrincipale;
  await page.locator('label.pastille', { hasText: 'Blanc' }).click();
  assert((await page.locator('#btn-telecharger').innerText()).includes('fond blanc'), 'libellé du bouton (blanc)');
  let dl = await telecharger(page, '#btn-telecharger');
  assert(dl.nom === 'portrait-cheveux-fond-blanc.png', `nom : ${dl.nom}`);
  let stats = await analyserBuffer(page, dl.buffer);
  assert(stats.transparent === 0 && stats.partiel === 0, 'un PNG avec fond doit être entièrement opaque');
  const { x, y } = sessionPrincipale.premierTransparent;
  const pixelBlanc = await page.evaluate(async ([b64, x, y]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    c.drawImage(bmp, 0, 0);
    return Array.from(c.getImageData(x, y, 1, 1).data);
  }, [dl.buffer.toString('base64'), x, y]);
  assert(pixelBlanc.join() === '255,255,255,255', `pixel de fond attendu blanc : ${pixelBlanc}`);

  await page.locator('#fond-couleur').evaluate((el) => {
    el.value = '#ff0000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert(await page.locator('input[name="fond"][value="couleur"]').isChecked(), 'l’option Couleur doit se cocher');
  dl = await telecharger(page, '#btn-telecharger');
  assert(dl.nom === 'portrait-cheveux-fond-ff0000.png', `nom : ${dl.nom}`);
  const pixelRouge = await page.evaluate(async ([b64, x, y]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    c.drawImage(bmp, 0, 0);
    return Array.from(c.getImageData(x, y, 1, 1).data);
  }, [dl.buffer.toString('base64'), x, y]);
  assert(pixelRouge.join() === '255,0,0,255', `pixel de fond attendu rouge : ${pixelRouge}`);
  await page.screenshot({ path: join(sortie, 'bureau-fond-rouge.png'), fullPage: true });
});

await test('comparateur avant/après : souris et clavier', async () => {
  const { page } = sessionPrincipale;
  const curseur = page.locator('.curseur');
  await curseur.evaluate((el) => {
    el.value = '20';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert((await page.locator('.comparateur').evaluate((el) => el.style.getPropertyValue('--pos'))) === '20%', 'position 20 %');
  await curseur.focus();
  await page.keyboard.press('ArrowRight');
  assert(Number(await curseur.inputValue()) > 20, 'le clavier doit déplacer le curseur');
  const boite = await page.locator('.comparateur').boundingBox();
  await page.mouse.click(boite.x + boite.width * 0.75, boite.y + boite.height / 2);
  const valeur = Number(await curseur.inputValue());
  assert(valeur > 65 && valeur < 85, `clic à 75 % → valeur ${valeur}`);
});

await test('« Nouvelle image » remet l’application à zéro', async () => {
  const { page, contexte } = sessionPrincipale;
  await page.click('#btn-nouvelle');
  assert(await page.locator('#accueil').isVisible() && (await page.locator('#espace').isHidden()), 'retour à l’accueil');
  assert((await page.evaluate(() => window.__detoure.etat.elements.length)) === 0, 'file vidée');
  await contexte.close();
});

console.log('\nImages difficiles et lots');
await test('grande image de 20 Mpx : pleine résolution, pixels identiques, interface fluide', async () => {
  const { contexte, page, erreurs } = await ouvrir();
  // Première image : le portrait (sert aussi de source pour fabriquer la grande photo).
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page);
  // Fabrique une vraie photo JPEG de 5472×3648 (≈ 20 Mpx) à partir du portrait, directement dans la page.
  await page.evaluate(async () => {
    const el = window.__detoure.etat.elements[0];
    const source = await createImageBitmap(el.fichier);
    const W = 5472;
    const H = 3648;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const echelle = W / source.width;
    ctx.drawImage(source, 0, (H - source.height * echelle) / 2, W, source.height * echelle);
    ctx.fillStyle = 'rgba(128,128,128,0.03)';
    for (let i = 0; i < 4000; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 3, 3);
    window.__grande = new File([await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })], 'grande-photo.jpg', { type: 'image/jpeg' });
    window.__ecarts = [];
    let dernier = performance.now();
    const tic = (t) => {
      window.__ecarts.push(t - dernier);
      dernier = t;
      requestAnimationFrame(tic);
    };
    requestAnimationFrame(tic);
  });
  const debut = Date.now();
  await page.evaluate(() => window.__detoure.ajouterFichiers([window.__grande]));
  await attendreTermine(page, 2, 240_000);
  const duree = (Date.now() - debut) / 1000;

  const verif = await page.evaluate(async () => {
    const el = window.__detoure.etat.elements[1];
    const r = el.resultat;
    const png = await createImageBitmap(r.png);
    const orig = await createImageBitmap(el.fichier);
    const lire = (bmp) => {
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const a = lire(png);
    const b = lire(orig);
    let echantillons = 0;
    let ecartMax = 0;
    let transparents = 0;
    let partiels = 0;
    for (let i = 0; i < a.length; i += 4 * 97) {
      const alpha = a[i + 3];
      if (alpha === 0) transparents++;
      else if (alpha < 255) partiels++;
      else {
        echantillons++;
        ecartMax = Math.max(ecartMax, Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      }
    }
    const ecarts = window.__ecarts.slice(2);
    return {
      largeur: png.width,
      hauteur: png.height,
      origW: orig.width,
      origH: orig.height,
      reduite: r.reduite,
      octets: r.png.size,
      echantillons,
      ecartMax,
      transparents,
      partiels,
      ecartImageMax: Math.max(...ecarts),
      ecartsLongs: ecarts.filter((e) => e > 250).length,
      duree: r.duree,
    };
  });
  console.log(`      ${verif.largeur}×${verif.hauteur} (${((verif.largeur * verif.hauteur) / 1e6).toFixed(1)} Mpx) en ${duree.toFixed(1)} s · PNG ${(verif.octets / 1e6).toFixed(1)} Mo · écart max de pixels opaques : ${verif.ecartMax}`);
  console.log(`      fluidité : plus long blocage de l’interface = ${verif.ecartImageMax.toFixed(0)} ms (${verif.ecartsLongs} images > 250 ms)`);
  assert(verif.largeur === verif.origW && verif.hauteur === verif.origH, `dimensions ${verif.largeur}×${verif.hauteur} ≠ ${verif.origW}×${verif.origH}`);
  assert(!verif.reduite, 'ne doit pas être réduite');
  assert(verif.echantillons > 1000 && verif.transparents > 200, 'masque incohérent');
  assert(verif.ecartMax === 0, `les pixels opaques doivent être IDENTIQUES à l’original (écart ${verif.ecartMax})`);
  assert(verif.ecartImageMax < 500, `l’interface a été bloquée ${verif.ecartImageMax.toFixed(0)} ms`);
  assert(erreurs.length === 0, `erreurs console : ${erreurs.join(' | ')}`);
  await contexte.close();
});

await test('lot de 3 images : traitement à la suite, archive .zip valide', async () => {
  const { contexte, page } = await ouvrir();
  await page.setInputFiles('#entree-fichiers', [images('chat-fourrure.jpg'), images('produit-tasse.jpg'), images('fusee.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('.file .element').length === 3);
  await attendreTermine(page, 3);
  assert(await page.locator('#btn-tout').isVisible(), 'bouton « Tout télécharger » attendu');
  // Clic sur la 2e image de la file : le résultat correspondant s'affiche
  await page.locator('.file .element').nth(1).click();
  assert(await page.locator('.file .element').nth(1).getAttribute('aria-current') === 'true', 'sélection');
  await page.locator('label.pastille', { hasText: 'Blanc' }).click();
  const { nom, chemin } = await telecharger(page, '#btn-tout');
  assert(nom === 'detoure-images.zip', `nom : ${nom}`);
  const zipCopie = join(sortie, 'lot.zip');
  writeFileSync(zipCopie, readFileSync(chemin));
  const test = execFileSync('unzip', ['-t', zipCopie]).toString();
  assert(/No errors detected/.test(test), `unzip -t : ${test}`);
  const liste = execFileSync('unzip', ['-Z1', zipCopie]).toString().trim().split('\n').sort();
  assert(liste.join() === 'chat-fourrure-fond-blanc.png,fusee-fond-blanc.png,produit-tasse-fond-blanc.png', `contenu du zip : ${liste}`);
  await page.screenshot({ path: join(sortie, 'bureau-lot.png'), fullPage: true });
  await contexte.close();
});

console.log('\nErreurs (messages en français)');
await test('format non pris en charge et fichier corrompu, puis reprise normale', async () => {
  const { contexte, page } = await ouvrir();
  await page.setInputFiles('#entree-fichiers', { name: 'dessin.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await page.waitForSelector('.erreur-scene');
  let texte = await page.locator('.erreur-scene').innerText();
  assert(texte.includes('Format non pris en charge') && texte.includes('JPG, PNG ou WEBP'), `message : ${texte}`);

  await page.setInputFiles('#entree-fichiers', { name: 'cassee.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) % 251)) });
  await page.locator('.file .element').nth(1).click();
  await page.waitForFunction(() => /Impossible de lire cette image/.test(document.querySelector('.erreur-scene')?.textContent ?? ''));

  await page.setInputFiles('#entree-fichiers', images('fusee.jpg'));
  await attendreTermine(page);
  assert(await page.locator('.statut.erreur').count() === 2, 'les deux erreurs doivent rester visibles dans la file');
  await contexte.close();
});

console.log('\nModèle, cache et hors ligne');
await test('barre de progression du téléchargement du modèle (connexion lente simulée)', async () => {
  process.env.DETOURE_TEST_LENT = '1';
  const { contexte, page } = await ouvrir();
  const valeurs = new Set();
  const textes = new Set();
  const suivi = setInterval(async () => {
    try {
      const v = await page.locator('#etat-barre').getAttribute('value', { timeout: 200 });
      if (v !== null) valeurs.add(Math.round(Number(v)));
      textes.add(await page.locator('#etat-texte').innerText({ timeout: 200 }));
      const detail = await page.locator('#etat-detail').innerText({ timeout: 200 });
      if (detail) textes.add(detail);
    } catch {
      /* élément momentanément absent */
    }
  }, 60);
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page);
  clearInterval(suivi);
  delete process.env.DETOURE_TEST_LENT;
  const intermediaires = [...valeurs].filter((v) => v > 0 && v < 100);
  console.log(`      valeurs de progression observées : ${[...valeurs].sort((a, b) => a - b).join(', ')}`);
  assert(intermediaires.length >= 2, `la barre doit avancer progressivement (vu : ${[...valeurs]})`);
  const tout = [...textes].join(' | ');
  assert(/Téléchargement du modèle d’IA/.test(tout) && /Mo/.test(tout), `texte de progression : ${tout}`);
  await contexte.close();
});

await test('hors ligne RÉEL (serveur arrêté) : rechargement + nouvelle image traitée depuis les caches', async () => {
  const srv = serveurArretable(4191);
  await srv.demarrer();
  const contexte = await navigateur.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await contexte.newPage();
  await page.goto(srv.url);
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated');
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page); // remplit les caches : application, moteur ONNX, modèle

  await srv.arreter();
  await page.reload();
  assert((await page.title()).includes('Détoure'), 'l’app doit se charger sans serveur');
  await page.waitForFunction(() => window.__detoure);
  await page.setInputFiles('#entree-fichiers', images('chat-fourrure.jpg'));
  await attendreTermine(page);
  console.log('      serveur arrêté : app rechargée et image traitée (modèle + moteur servis depuis les caches)');
  await contexte.close();
});

await test('modèle absent du cache + serveur arrêté : message clair, puis « Réessayer » une fois reconnecté', async () => {
  const srv = serveurArretable(4192);
  await srv.demarrer();
  const contexte = await navigateur.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await contexte.newPage();
  await page.goto(srv.url);
  await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated');
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page);

  // On efface uniquement le modèle, on coupe le serveur et on recharge (nouveau worker, modèle à re-télécharger).
  await page.evaluate(() => caches.delete('transformers-cache'));
  await srv.arreter();
  await page.reload();
  await page.waitForFunction(() => window.__detoure);
  await page.setInputFiles('#entree-fichiers', images('chat-fourrure.jpg'));
  await page.waitForSelector('.erreur-scene', { timeout: 60_000 });
  const texte = await page.locator('.erreur-scene').innerText();
  assert(/Impossible de télécharger le modèle d’IA/.test(texte) && /connexion internet/.test(texte), `message : ${texte}`);
  assert(await page.getByRole('button', { name: 'Réessayer' }).isVisible(), 'bouton Réessayer attendu');

  // La connexion revient : « Réessayer » doit fonctionner sans recharger la page.
  await srv.demarrer();
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await attendreTermine(page);
  await contexte.close();
  await srv.arreter();
});

// --- Version de PRODUCTION (sans le modèle de test) avec Hugging Face simulé --------------------------
console.log('\nConfiguration de production (Hugging Face simulé)');
await build({ mode: 'production', logLevel: 'silent', build: { outDir: 'dist-test-prod' } });
const srvProd = await preview({ mode: 'production', logLevel: 'silent', build: { outDir: 'dist-test-prod' }, preview: { port: 4201, strictPort: false } });
const modele = (nom) => readFileSync(join(racine, 'tests', 'modeles-factices', `${nom}.onnx`));

/**
 * Ouvre l'application de production dans un contexte où huggingface.co est simulé.
 * @param {(chemin: string) => Buffer | null | undefined} fichiers  contenu du fichier `onnx/...` demandé (null = 404)
 * @param {string} preference  réglage « Modèle d'IA » (auto, precis, rapide)
 */
async function ouvrirProduction(fichiers, preference = 'auto') {
  const contexte = await navigateur.newContext({ viewport: { width: 1100, height: 900 } });
  await contexte.addInitScript((pref) => localStorage.setItem('detoure.modele', pref), preference);
  const vus = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range, content-length' };
  await contexte.route('https://huggingface.co/**', (route) => {
    const req = route.request();
    const chemin = req.url().replace('https://huggingface.co/', '');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!vus.includes(chemin)) vus.push(chemin);
    if (chemin.endsWith('config.json')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ model_type: 'test' }) });
    const corps = fichiers(chemin);
    if (!corps) return route.fulfill({ status: 404, headers: cors, body: 'Entry not found' });
    // Comme Hugging Face : une requête « Range: bytes=0-0 » sert d'abord à connaître la taille du fichier.
    if (req.headers().range) return route.fulfill({ status: 206, headers: { ...cors, 'content-range': `bytes 0-0/${corps.length}`, 'content-length': '1' }, body: corps.subarray(0, 1) });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-length': String(corps.length) }, body: corps });
  });
  const page = await contexte.newPage();
  await page.goto(srvProd.resolvedUrls.local[0]);
  return { contexte, page, vus };
}

await test('sans WebGPU : MODNet directement — aucun téléchargement de BiRefNet — et détails techniques complets', async () => {
  const { contexte, page, vus } = await ouvrirProduction(() => null); // tous les .onnx en 404
  await page.setInputFiles('#entree-fichiers', images('fusee.jpg'));
  await page.waitForSelector('.erreur-scene', { timeout: 60_000 });
  const attendu = [
    'Xenova/modnet/resolve/main/config.json',
    'Xenova/modnet/resolve/main/onnx/model.onnx',
    'Xenova/modnet/resolve/main/onnx/model_quantized.onnx',
  ];
  assert(JSON.stringify(vus) === JSON.stringify(attendu), `URL demandées :\n        ${vus.join('\n        ')}`);
  assert(!vus.some((u) => /rmbg|briaai|birefnet/i.test(u)), 'ni RMBG (licence non commerciale) ni BiRefNet (WASM insuffisant) ne doivent être demandés');
  assert(/n’a pas pu démarrer sur cet appareil/.test(await page.locator('.erreur-scene').innerText()), 'message');
  await page.locator('.technique summary').click();
  const details = await page.locator('.technique pre').innerText();
  for (const attendu of ['WebGPU (worker) :', 'modnet|wasm|fp32', 'modnet|wasm|q8', 'Could not locate file', 'Navigateur :']) {
    assert(details.includes(attendu), `« ${attendu} » absent des détails techniques :\n${details}`);
  }
  assert(await page.getByRole('button', { name: 'Copier les détails' }).isVisible(), 'bouton Copier attendu');
  await contexte.close();
});

await test('mode « Précis » sans WebGPU : message explicite, aucun téléchargement', async () => {
  const { contexte, page, vus } = await ouvrirProduction(() => modele('ok'), 'precis');
  await page.setInputFiles('#entree-fichiers', images('fusee.jpg'));
  await page.waitForSelector('.erreur-scene', { timeout: 60_000 });
  const texte = await page.locator('.erreur-scene').innerText();
  assert(/nécessite WebGPU/.test(texte) && /chrome:\/\/gpu/.test(texte), `message : ${texte}`);
  assert(vus.length === 0, `rien ne doit être téléchargé : ${vus}`);
  // Le réglage reste accessible une fois les images chargées, et un bouton corrige le réglage en un clic.
  await page.locator('.reglages summary').click();
  assert((await page.locator('#reglage-modele').inputValue()) === 'precis', 'le réglage enregistré (Précis) doit être affiché');
  await page.getByRole('button', { name: 'Passer en mode Automatique et réessayer' }).click();
  await attendreTermine(page, 1, 60_000);
  assert(/MODNet \(WASM\)/.test(await page.locator('#meta-resultat').innerText()), 'MODNet doit traiter l’image');
  assert((await page.locator('#reglage-modele').inputValue()) === 'auto', 'le réglage doit passer à Automatique');
  assert((await page.evaluate(() => localStorage.getItem('detoure.modele'))) === 'auto', 'le nouveau réglage doit être mémorisé');
  await contexte.close();
});

await test('échec mémoire du moteur → worker neuf → modèle suivant : l’image est quand même détourée', async () => {
  // MODNet « complet » (fp32) épuise la mémoire à l'inférence (comme BiRefNet en WASM chez l'utilisateur) ;
  // MODNet « léger » (q8) fonctionne. Sans redémarrage du worker, le second échouait aussi (constaté).
  const { contexte, page, vus } = await ouvrirProduction((chemin) => (/model_quantized\.onnx$/.test(chemin) ? modele('ok') : /onnx\/model\.onnx$/.test(chemin) ? modele('oom') : null));
  const etapes = [];
  await page.exposeFunction('noterEtape', (t) => etapes.push(t));
  await page.evaluate(() => {
    new MutationObserver(() => window.noterEtape(document.querySelector('#etat-texte')?.textContent ?? '')).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page, 1, 90_000);
  const meta = await page.locator('#meta-resultat').innerText();
  assert(/MODNet \(WASM\)/.test(meta), `meta : ${meta}`);
  assert(/WebGPU indisponible/.test(meta), 'le conseil WebGPU doit s’afficher');
  assert(etapes.some((t) => /Nouvel essai avec un autre modèle/.test(t)), 'le changement de modèle doit être annoncé à l’utilisateur');
  assert(vus.some((u) => u.endsWith('model_quantized.onnx')), `q8 doit avoir été essayé : ${vus}`);
  // L'image suivante ne doit pas retenter la combinaison qui a échoué.
  const avant = vus.length;
  await page.setInputFiles('#entree-fichiers', images('chat-fourrure.jpg'));
  await attendreTermine(page, 2, 60_000);
  assert(vus.length === avant, `la combinaison en échec ne doit pas être re-téléchargée : ${vus.slice(avant)}`);
  await contexte.close();
});

srvProd.httpServer.close();

console.log('\nMobile et mode sombre');
await test('mobile (390 px) : pas de défilement horizontal, mode sombre automatique', async () => {
  const { contexte, page } = await ouvrir({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'dark' });
  const fondCorps = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(fondCorps === 'rgb(14, 15, 20)', `fond sombre attendu, obtenu ${fondCorps}`);
  assert(await page.getByRole('button', { name: 'Prendre une photo' }).isVisible(), 'bouton photo attendu sur mobile');
  await page.screenshot({ path: join(sortie, 'mobile-sombre-accueil.png'), fullPage: true });
  await page.setInputFiles('#entree-fichiers', images('portrait-cheveux.jpg'));
  await attendreTermine(page);
  const debordement = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(debordement <= 0, `défilement horizontal de ${debordement} px`);
  await page.screenshot({ path: join(sortie, 'mobile-sombre-resultat.png'), fullPage: true });
  await contexte.close();
});

await test('mobile clair : accueil et À propos sans débordement', async () => {
  const { contexte, page } = await ouvrir({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  await page.screenshot({ path: join(sortie, 'mobile-clair-accueil.png'), fullPage: true });
  await page.getByRole('link', { name: 'À propos' }).click();
  await page.waitForSelector('#vue-apropos:not([hidden])');
  await page.screenshot({ path: join(sortie, 'mobile-clair-apropos.png'), fullPage: true });
  const debordement = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(debordement <= 0, `défilement horizontal de ${debordement} px`);
  await contexte.close();
});

console.log('\nInformations');
await test('WebGPU disponible dans ce Chromium ? (information, ne fait jamais échouer)', async () => {
  const { contexte, page } = await ouvrir();
  const info = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return 'navigator.gpu absent';
    const adaptateur = await navigator.gpu.requestAdapter().catch(() => null);
    return adaptateur ? 'adaptateur WebGPU disponible' : 'navigator.gpu présent mais aucun adaptateur (normal en environnement sans GPU)';
  });
  console.log(`      ${info}`);
  await contexte.close();
});

// ---------------------------------------------------------------------------
await navigateur.close();
serveur.httpServer.close();
const code = bilan();
console.log(`Captures d’écran dans ${sortie}`);
process.exit(code);
