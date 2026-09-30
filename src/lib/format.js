/** Petites fonctions d'affichage (tailles, durées, noms de fichiers). */

/** 1 234 567 → « 1,2 Mo » */
export function formaterOctets(octets) {
  if (!Number.isFinite(octets)) return '';
  if (octets < 1024 * 1024) return `${Math.max(1, Math.round(octets / 1024))} Ko`;
  const mo = octets / (1024 * 1024);
  return `${mo.toLocaleString('fr-FR', { maximumFractionDigits: mo >= 100 ? 0 : 1 })} Mo`;
}

/** 4 032 × 3 024 → « 12,2 Mpx » */
export function formaterMegapixels(largeur, hauteur) {
  const mpx = (largeur * hauteur) / 1e6;
  return `${mpx.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mpx`;
}

/** 12 300 ms → « 12,3 s » */
export function formaterDuree(ms) {
  return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
}

/** « ma photo.final.JPG » → « ma photo.final » */
export function nomSansExtension(nom) {
  return nom.replace(/\.[^./\\]+$/, '') || 'image';
}

/** Nettoie un nom pour l'utiliser comme nom de fichier téléchargé. */
export function nomFichierSur(nom) {
  return nom.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'image';
}
