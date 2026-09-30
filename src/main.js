/**
 * Détoure – point d'entrée de l'interface.
 * Gère : dépôt des fichiers, file d'attente, affichage de l'avancement, comparateur,
 * options de fond, téléchargements, navigation (accueil / À propos), PWA.
 */
import './style.css';
import { FORMATS_ACCEPTES, MODE_TEST, TAILLE_MAX_FICHIER } from './config.js';
import { ErreurDetourage, messagePourCode } from './lib/erreurs.js';
import { formaterDuree, formaterMegapixels, formaterOctets, nomFichierSur, nomSansExtension } from './lib/format.js';
import { Moteur } from './lib/moteur.js';
import { creerZip } from './lib/zip.js';
import { creerComparateur } from './ui/comparateur.js';
import { FileAttente } from './ui/file-attente.js';

const $ = (selecteur) => document.querySelector(selecteur);

// ---------------------------------------------------------------------------
// État de l'application
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Element
 * @property {number} id
 * @property {File} fichier
 * @property {'attente'|'encours'|'ok'|'erreur'} statut
 * @property {string|null} urlOriginale  aperçu du fichier d'origine (tant qu'il n'est pas traité)
 * @property {string|null} urlApercu     petite vignette une fois traité
 * @property {object|null} resultat      { png, apercuAvant, apercuApres, largeur, hauteur, … }
 * @property {string|null} urlAvant
 * @property {string|null} urlApres
 * @property {string|null} codeErreur
 * @property {string|null} detailErreur  détail technique de l'échec (affiché dans « Détails techniques »)
 */
const etat = {
  /** @type {Element[]} */
  elements: [],
  selection: null,
  fond: 'transparent', // 'transparent' | 'blanc' | 'couleur'
  occupe: false,
  session: 0, // incrémentée par « Nouvelle image » pour ignorer les résultats devenus obsolètes
  prochainId: 1,
};

const moteur = new Moteur();
const file = new FileAttente($('#file'), (id) => selectionner(id));

// ---------------------------------------------------------------------------
// Réglages mémorisés (localStorage peut être indisponible : on protège chaque accès)
// ---------------------------------------------------------------------------

const CLE_MODELE = 'detoure.modele';
const lire = (cle, defaut) => {
  try {
    return localStorage.getItem(cle) ?? defaut;
  } catch {
    return defaut;
  }
};
const ecrire = (cle, valeur) => {
  try {
    localStorage.setItem(cle, valeur);
  } catch {
    /* ignoré */
  }
};

const selectModele = $('#reglage-modele');
selectModele.value = ['auto', 'precis', 'rapide'].includes(lire(CLE_MODELE, 'auto')) ? lire(CLE_MODELE, 'auto') : 'auto';
selectModele.addEventListener('change', () => ecrire(CLE_MODELE, selectModele.value));

// ---------------------------------------------------------------------------
// Ajout de fichiers
// ---------------------------------------------------------------------------

function formatAccepte(fichier) {
  if (FORMATS_ACCEPTES.includes(fichier.type)) return true;
  return !fichier.type && /\.(jpe?g|png|webp)$/i.test(fichier.name); // certains Android n'indiquent pas le type
}

/** Ajoute des fichiers à la file d'attente (glisser-déposer, sélecteur, appareil photo, collage). */
function ajouterFichiers(fichiers) {
  const liste = [...fichiers];
  if (!liste.length) return;

  for (const fichier of liste) {
    /** @type {Element} */
    const element = {
      id: etat.prochainId++,
      fichier,
      statut: 'attente',
      urlOriginale: null,
      urlApercu: null,
      resultat: null,
      urlAvant: null,
      urlApres: null,
      codeErreur: null,
      detailErreur: null,
    };
    if (!formatAccepte(fichier)) {
      element.statut = 'erreur';
      element.codeErreur = 'format';
    } else if (fichier.size > TAILLE_MAX_FICHIER) {
      element.statut = 'erreur';
      element.codeErreur = 'trop-lourd';
    } else {
      element.urlOriginale = URL.createObjectURL(fichier);
    }
    etat.elements.push(element);
  }

  // On affiche tout de suite la première image ajoutée si rien n'est sélectionné.
  if (etat.selection === null || !etat.elements.some((e) => e.id === etat.selection)) {
    etat.selection = etat.elements.find((e) => e.statut !== 'erreur')?.id ?? etat.elements[0].id;
  }
  afficherEspace();
  rendre();
  traiterFile();
}

// ---------------------------------------------------------------------------
// Traitement séquentiel
// ---------------------------------------------------------------------------

async function traiterFile() {
  if (etat.occupe) return;
  etat.occupe = true;
  try {
    let suivant;
    while ((suivant = etat.elements.find((e) => e.statut === 'attente'))) {
      await traiterUn(suivant);
    }
  } finally {
    etat.occupe = false;
    if (!etat.elements.some((e) => e.statut === 'encours')) masquerEtat();
  }
}

const TEXTES_ETAPES = {
  lecture: 'Lecture de l’image…',
  modele: 'Chargement de l’IA…',
  analyse: 'Analyse de l’image par l’IA…',
  decoupe: 'Découpe en haute définition…',
  export: 'Création du PNG…',
  redemarrage: 'Nouvel essai avec un autre modèle…',
};

/** Numéro de l'image dans la session, pour les libellés « Image 2 sur 5 ». */
function prefixeImage(element) {
  const total = etat.elements.length;
  return total > 1 ? `Image ${etat.elements.indexOf(element) + 1} sur ${total} · ` : '';
}

async function traiterUn(element) {
  const session = etat.session;
  const actuel = () => session === etat.session;
  element.statut = 'encours';
  rendre();

  let debutEtape = performance.now();
  let minuteur = null;
  const arreterMinuteur = () => clearInterval(minuteur);
  const afficher = (etape, valeur, detail) => {
    if (!actuel()) return;
    afficherEtat(`${prefixeImage(element)}${TEXTES_ETAPES[etape] ?? 'Traitement…'}`, valeur, detail);
  };

  try {
    const resultat = await moteur.traiter(element.fichier, {
      preference: selectModele.value,
      surEtat: (etape) => {
        arreterMinuteur();
        debutEtape = performance.now();
        afficher(etape, undefined, '');
        // Pendant l'analyse, on montre un compteur pour rassurer sur les appareils lents.
        if (etape === 'analyse' || etape === 'modele') {
          minuteur = setInterval(() => {
            const secondes = Math.round((performance.now() - debutEtape) / 1000);
            if (secondes >= 3) afficher(etape, undefined, `${secondes} s… patience, tout se passe sur votre appareil.`);
          }, 1000);
        }
      },
      surModele: ({ loaded, total }) => {
        if (!total) return;
        const pourcent = Math.min(100, (loaded / total) * 100);
        afficherEtat(
          `${prefixeImage(element)}Téléchargement du modèle d’IA (première utilisation uniquement)`,
          pourcent,
          `${Math.floor(pourcent)} % · ${formaterOctets(loaded)} sur ${formaterOctets(total)} — ensuite, plus besoin d’internet.`,
        );
      },
    });
    arreterMinuteur();
    if (!actuel()) return;

    element.resultat = resultat;
    element.urlAvant = URL.createObjectURL(resultat.apercuAvant);
    element.urlApres = URL.createObjectURL(resultat.apercuApres);
    // La vignette légère remplace l'aperçu du fichier d'origine (économie de mémoire).
    if (element.urlOriginale) URL.revokeObjectURL(element.urlOriginale);
    element.urlOriginale = null;
    element.urlApercu = element.urlAvant;
    element.statut = 'ok';
    demanderStockagePersistant();
  } catch (erreur) {
    arreterMinuteur();
    if (!actuel()) return;
    const code = erreur instanceof ErreurDetourage ? erreur.code : 'inconnue';
    console.error('[traitement]', erreur);
    element.statut = 'erreur';
    element.codeErreur = code;
    element.detailErreur = erreur instanceof ErreurDetourage ? erreur.detail : String(erreur?.message ?? erreur);
  }
  rendre();
}

/** Demande au navigateur de ne pas effacer le modèle mis en cache quand la place manque. */
function demanderStockagePersistant() {
  navigator.storage?.persist?.().catch(() => {});
}

// ---------------------------------------------------------------------------
// Affichage : avancement
// ---------------------------------------------------------------------------

function afficherEtat(texte, valeur, detail = '') {
  $('#etat').hidden = false;
  $('#etat-texte').textContent = texte;
  const barre = $('#etat-barre');
  if (valeur === undefined) barre.removeAttribute('value');
  else barre.value = valeur;
  $('#etat-detail').textContent = detail;
}

function masquerEtat() {
  $('#etat').hidden = true;
}

// ---------------------------------------------------------------------------
// Affichage : scène (aperçu / comparateur / erreur), options, actions
// ---------------------------------------------------------------------------

let comparateur = null;
let elementAffiche = null; // { id, statut } pour éviter de reconstruire la scène inutilement

function elementSelectionne() {
  return etat.elements.find((e) => e.id === etat.selection) ?? null;
}

function selectionner(id) {
  etat.selection = id;
  rendre();
}

/** Couleur CSS du fond choisi, ou null pour le damier (transparent). */
function couleurFond() {
  if (etat.fond === 'blanc') return '#ffffff';
  if (etat.fond === 'couleur') return $('#fond-couleur').value;
  return null;
}

function rendre() {
  file.mettreAJour(etat.elements, etat.selection);
  const el = elementSelectionne();
  const scene = $('#scene');

  const cle = el ? `${el.id}:${el.statut}` : '';
  if (elementAffiche !== cle) {
    elementAffiche = cle;
    scene.replaceChildren();
    comparateur = null;
    if (el) construireScene(scene, el);
  }

  const ok = el?.statut === 'ok';
  $('#options').hidden = !ok;
  $('#actions').hidden = !ok;
  $('#btn-tout').hidden = etat.elements.filter((e) => e.statut === 'ok').length < 2;
  $('#meta-resultat').textContent = ok ? descriptionResultat(el.resultat) : '';
  if (ok) {
    comparateur?.definirFond(couleurFond());
    majLibelleTelechargement();
  }
}

function construireScene(scene, el) {
  const ratio = (el.resultat ? el.resultat.largeur / el.resultat.hauteur : null) ?? 1.5;

  if (el.statut === 'ok') {
    comparateur = creerComparateur({
      urlAvant: el.urlAvant,
      urlApres: el.urlApres,
      largeur: el.resultat.largeur,
      hauteur: el.resultat.hauteur,
    });
    scene.append(comparateur.element);
  } else if (el.statut === 'erreur') {
    const boite = document.createElement('div');
    boite.className = 'erreur-scene';
    boite.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = messagePourCode(el.codeErreur);
    boite.append(message);
    if (el.urlOriginale || !['format', 'trop-lourd'].includes(el.codeErreur)) {
      const bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'bouton';
      bouton.textContent = 'Réessayer';
      bouton.addEventListener('click', () => {
        el.statut = 'attente';
        el.codeErreur = null;
        el.detailErreur = null;
        rendre();
        traiterFile();
      });
      boite.append(bouton);
    }
    if (el.detailErreur) boite.append(creerDetailsTechniques(el.detailErreur));
    scene.append(boite);
  } else {
    // En attente ou en cours : on montre l'image d'origine, estompée.
    const boite = document.createElement('div');
    boite.className = 'attente';
    boite.innerHTML = '<img alt="Image en cours de traitement" /><div class="voile"></div>';
    const image = boite.querySelector('img');
    image.src = el.urlOriginale ?? '';
    // Le ratio réel est lu une fois l'image chargée (l'aperçu du fichier d'origine est léger à décoder).
    boite.style.setProperty('--ratio', String(ratio));
    image.addEventListener('load', () => boite.style.setProperty('--ratio', String(image.naturalWidth / image.naturalHeight)));
    boite.querySelector('.voile').textContent = el.statut === 'encours' ? 'Traitement en cours…' : 'En attente…';
    scene.append(boite);
  }
}

/**
 * Bloc repliable « Détails techniques » + bouton pour copier le texte : indispensable pour
 * comprendre pourquoi un modèle n'a pas démarré sur un appareil donné (et pour le signaler).
 */
function creerDetailsTechniques(detail) {
  const texte = [detail, '', `Navigateur : ${navigator.userAgent}`, `WebGPU : ${'gpu' in navigator ? 'oui' : 'non'}`].join('\n').trim();
  const bloc = document.createElement('details');
  bloc.className = 'technique';
  const resume = document.createElement('summary');
  resume.textContent = 'Détails techniques';
  const contenu = document.createElement('pre');
  contenu.textContent = texte;
  const copier = document.createElement('button');
  copier.type = 'button';
  copier.className = 'bouton petit';
  copier.textContent = 'Copier les détails';
  copier.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(texte);
      copier.textContent = 'Copié ✓';
    } catch {
      getSelection()?.selectAllChildren(contenu); // presse-papiers refusé : on sélectionne le texte pour Ctrl+C
      copier.textContent = 'Texte sélectionné : Ctrl+C';
    }
  });
  bloc.append(resume, contenu, copier);
  return bloc;
}

function descriptionResultat(r) {
  const parties = [
    `${r.largeur} × ${r.hauteur} px (${formaterMegapixels(r.largeur, r.hauteur)})`,
    `PNG de ${formaterOctets(r.png.size)}`,
    `${formaterDuree(r.duree)} · ${r.modele} (${r.moteur === 'webgpu' ? 'WebGPU' : 'WASM'})`,
  ];
  if (r.modele === 'MODNet' && r.moteur === 'wasm') {
    parties.push('ℹ️ WebGPU indisponible : MODNet (conçu pour les portraits) a été utilisé');
  }
  if (r.reduite) {
    parties.push(
      `⚠ Image réduite de ${formaterMegapixels(r.largeurOrigine, r.hauteurOrigine)} à ${formaterMegapixels(r.largeur, r.hauteur)} : trop grande pour cet appareil`,
    );
  }
  return parties.join(' · ');
}

// ---------------------------------------------------------------------------
// Options de fond et téléchargements
// ---------------------------------------------------------------------------

document.querySelectorAll('input[name="fond"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    etat.fond = radio.value;
    rendre();
  });
});
// Choisir une couleur sélectionne automatiquement l'option « Couleur ».
$('#fond-couleur').addEventListener('input', () => {
  etat.fond = 'couleur';
  document.querySelector('input[name="fond"][value="couleur"]').checked = true;
  rendre();
});

function majLibelleTelechargement() {
  const libelles = {
    transparent: 'Télécharger le PNG transparent',
    blanc: 'Télécharger le PNG (fond blanc)',
    couleur: 'Télécharger le PNG (fond coloré)',
  };
  $('#btn-telecharger').textContent = libelles[etat.fond];
}

/** Suffixe de nom de fichier selon le fond. */
function suffixeFond() {
  if (etat.fond === 'blanc') return 'fond-blanc';
  if (etat.fond === 'couleur') return `fond-${$('#fond-couleur').value.slice(1)}`;
  return 'sans-fond';
}

/** PNG à télécharger pour un élément, selon le fond choisi (composé dans le worker si besoin). */
async function pngPourTelechargement(el) {
  const couleur = couleurFond();
  return couleur ? moteur.ajouterFond(el.resultat.png, couleur) : el.resultat.png;
}

function declencherTelechargement(blob, nom) {
  const url = URL.createObjectURL(blob);
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = nom;
  document.body.append(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Désactive un bouton pendant une opération asynchrone et affiche un éventuel message d'erreur. */
async function avecBouton(bouton, libelleOccupe, action) {
  const libelle = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = libelleOccupe;
  try {
    await action();
  } catch (erreur) {
    console.error('[téléchargement]', erreur);
    const code = erreur instanceof ErreurDetourage ? erreur.code : 'inconnue';
    $('#meta-resultat').textContent = `⚠ ${messagePourCode(code)}`;
  } finally {
    bouton.disabled = false;
    bouton.textContent = libelle;
    majLibelleTelechargement();
  }
}

$('#btn-telecharger').addEventListener('click', () => {
  const el = elementSelectionne();
  if (el?.statut !== 'ok') return;
  avecBouton($('#btn-telecharger'), 'Préparation du PNG…', async () => {
    const blob = await pngPourTelechargement(el);
    declencherTelechargement(blob, `${nomFichierSur(nomSansExtension(el.fichier.name))}-${suffixeFond()}.png`);
  });
});

$('#btn-tout').addEventListener('click', () => {
  const termines = etat.elements.filter((e) => e.statut === 'ok');
  if (!termines.length) return;
  avecBouton($('#btn-tout'), 'Création du .zip…', async () => {
    const fichiers = [];
    const noms = new Set();
    for (const el of termines) {
      // Deux fichiers portant le même nom recevraient le même nom dans l'archive : on numérote.
      const base = `${nomFichierSur(nomSansExtension(el.fichier.name))}-${suffixeFond()}`;
      let nom = `${base}.png`;
      for (let n = 2; noms.has(nom); n++) nom = `${base}-${n}.png`;
      noms.add(nom);
      fichiers.push({ nom, blob: await pngPourTelechargement(el) });
    }
    declencherTelechargement(await creerZip(fichiers), 'detoure-images.zip');
  });
});

// ---------------------------------------------------------------------------
// Dépôt de fichiers : boutons, glisser-déposer, collage
// ---------------------------------------------------------------------------

const entreeFichiers = $('#entree-fichiers');
const entreePhoto = $('#entree-photo');

$('#btn-choisir').addEventListener('click', () => entreeFichiers.click());
$('#btn-ajouter').addEventListener('click', () => entreeFichiers.click());
$('#btn-photo').addEventListener('click', () => entreePhoto.click());
for (const entree of [entreeFichiers, entreePhoto]) {
  entree.addEventListener('change', () => {
    ajouterFichiers(entree.files);
    entree.value = ''; // permet de re-choisir le même fichier
  });
}

// Le bouton « Prendre une photo » n'a de sens que sur les appareils tactiles.
if (window.matchMedia('(pointer: coarse)').matches) $('#btn-photo').hidden = false;

const zoneDepot = $('#zone-depot');
const voile = $('#voile-depot');
let compteurGlisse = 0;
const contientFichiers = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

document.addEventListener('dragenter', (e) => {
  if (!contientFichiers(e)) return;
  compteurGlisse++;
  voile.hidden = false;
  zoneDepot.classList.add('survol');
});
document.addEventListener('dragleave', (e) => {
  if (!contientFichiers(e)) return;
  compteurGlisse = Math.max(0, compteurGlisse - 1);
  if (!compteurGlisse) {
    voile.hidden = true;
    zoneDepot.classList.remove('survol');
  }
});
document.addEventListener('dragover', (e) => {
  if (contientFichiers(e)) e.preventDefault(); // nécessaire pour autoriser le dépôt
});
document.addEventListener('drop', (e) => {
  if (!contientFichiers(e)) return;
  e.preventDefault();
  compteurGlisse = 0;
  voile.hidden = true;
  zoneDepot.classList.remove('survol');
  aller('#/'); // si on était sur « À propos », on revient à l'application
  ajouterFichiers(e.dataTransfer.files);
});

// Coller une image (Ctrl+V / Cmd+V)
document.addEventListener('paste', (e) => {
  const fichiers = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (fichiers.length) {
    e.preventDefault();
    ajouterFichiers(fichiers);
  }
});

// ---------------------------------------------------------------------------
// Nouvelle image
// ---------------------------------------------------------------------------

$('#btn-nouvelle').addEventListener('click', () => {
  etat.session++;
  for (const el of etat.elements) {
    for (const url of [el.urlOriginale, el.urlAvant, el.urlApres]) if (url) URL.revokeObjectURL(url);
  }
  etat.elements = [];
  etat.selection = null;
  elementAffiche = null;
  masquerEtat();
  rendre();
  $('#espace').hidden = true;
  $('#accueil').hidden = false;
  window.scrollTo({ top: 0 });
  $('#btn-choisir').focus({ preventScroll: true });
});

function afficherEspace() {
  $('#accueil').hidden = true;
  $('#espace').hidden = false;
}

// ---------------------------------------------------------------------------
// Navigation : accueil / À propos (routage par « # », fonctionne sur tout hébergement statique)
// ---------------------------------------------------------------------------

function aller(hash) {
  if (location.hash !== hash) location.hash = hash;
}

function routage() {
  const apropos = location.hash === '#/a-propos';
  $('#vue-app').hidden = apropos;
  $('#vue-apropos').hidden = !apropos;
  document.title = apropos ? 'À propos – Détoure' : 'Détoure – Supprimer l’arrière-plan d’une image';
  window.scrollTo({ top: 0 });
  if (apropos) $('#titre-apropos').focus({ preventScroll: true });
}
window.addEventListener('hashchange', routage);
routage();

// ---------------------------------------------------------------------------
// PWA : service worker, mise à jour, installation, état de la connexion
// ---------------------------------------------------------------------------

function majReseau() {
  $('#badge-reseau').hidden = navigator.onLine;
}
window.addEventListener('online', majReseau);
window.addEventListener('offline', majReseau);
majReseau();

// Bouton « Installer » (Chrome/Edge/Android) : on garde l'événement pour le déclencher au clic.
let installation = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installation = e;
  $('#btn-installer').hidden = false;
});
$('#btn-installer').addEventListener('click', async () => {
  if (!installation) return;
  installation.prompt();
  await installation.userChoice.catch(() => {});
  installation = null;
  $('#btn-installer').hidden = true;
});
window.addEventListener('appinstalled', () => {
  $('#btn-installer').hidden = true;
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // On ne recharge la page que si l'utilisateur a cliqué sur « Mettre à jour » : à la toute
  // première installation le service worker prend aussi le contrôle, sans qu'il faille recharger.
  let miseAJourDemandee = false;
  navigator.serviceWorker
    .register('./sw.js')
    .then((inscription) => {
      // Quand une nouvelle version est prête, on propose de recharger (sans interrompre un traitement en cours).
      const proposerMiseAJour = (worker) => {
        $('#bandeau-maj').hidden = false;
        $('#btn-maj').onclick = () => {
          miseAJourDemandee = true;
          worker.postMessage('SKIP_WAITING');
        };
      };
      if (inscription.waiting && navigator.serviceWorker.controller) proposerMiseAJour(inscription.waiting);
      inscription.addEventListener('updatefound', () => {
        const nouveau = inscription.installing;
        nouveau?.addEventListener('statechange', () => {
          if (nouveau.state === 'installed' && navigator.serviceWorker.controller) proposerMiseAJour(nouveau);
        });
      });
    })
    .catch((erreur) => console.warn('Service worker non enregistré :', erreur));

  let rechargement = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (rechargement || !miseAJourDemandee) return;
    rechargement = true;
    location.reload();
  });
}

// Petit point d'entrée pour les tests automatisés (absent en production).
if (MODE_TEST) window.__detoure = { etat, ajouterFichiers };
