/**
 * Mini-générateur d'archive ZIP (sans compression, format « stored »).
 * Les PNG sont déjà compressés : inutile de les compresser une seconde fois.
 * Permet de télécharger plusieurs images d'un seul clic, sans bibliothèque externe.
 */

const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(octets) {
  let crc = 0xffffffff;
  for (let i = 0; i < octets.length; i++) crc = TABLE_CRC[(crc ^ octets[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Date/heure au format MS-DOS, exigé par le format ZIP. */
function dateDos(date) {
  return {
    heure: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    jour: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {{ nom: string, blob: Blob }[]} fichiers
 * @returns {Promise<Blob>} archive ZIP
 */
export async function creerZip(fichiers) {
  const encodeur = new TextEncoder();
  const { heure, jour } = dateDos(new Date());
  const parties = [];
  const annuaire = [];
  let decalage = 0;

  for (const { nom, blob } of fichiers) {
    const nomOctets = encodeur.encode(nom);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));

    // En-tête local (30 octets + nom). Bit 11 = noms en UTF-8.
    const entete = new DataView(new ArrayBuffer(30));
    entete.setUint32(0, 0x04034b50, true);
    entete.setUint16(4, 20, true);
    entete.setUint16(6, 0x0800, true);
    entete.setUint16(8, 0, true); // méthode 0 = stockage sans compression
    entete.setUint16(10, heure, true);
    entete.setUint16(12, jour, true);
    entete.setUint32(14, crc, true);
    entete.setUint32(18, blob.size, true);
    entete.setUint32(22, blob.size, true);
    entete.setUint16(26, nomOctets.length, true);
    entete.setUint16(28, 0, true);
    parties.push(entete.buffer, nomOctets, blob);

    annuaire.push({ nomOctets, crc, taille: blob.size, decalage });
    decalage += 30 + nomOctets.length + blob.size;
  }

  // Répertoire central + fin d'archive
  const debutAnnuaire = decalage;
  let tailleAnnuaire = 0;
  for (const f of annuaire) {
    const entree = new DataView(new ArrayBuffer(46));
    entree.setUint32(0, 0x02014b50, true);
    entree.setUint16(4, 20, true);
    entree.setUint16(6, 20, true);
    entree.setUint16(8, 0x0800, true);
    entree.setUint16(10, 0, true);
    entree.setUint16(12, heure, true);
    entree.setUint16(14, jour, true);
    entree.setUint32(16, f.crc, true);
    entree.setUint32(20, f.taille, true);
    entree.setUint32(24, f.taille, true);
    entree.setUint16(28, f.nomOctets.length, true);
    entree.setUint32(42, f.decalage, true);
    parties.push(entree.buffer, f.nomOctets);
    tailleAnnuaire += 46 + f.nomOctets.length;
  }
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, annuaire.length, true);
  fin.setUint16(10, annuaire.length, true);
  fin.setUint32(12, tailleAnnuaire, true);
  fin.setUint32(16, debutAnnuaire, true);
  parties.push(fin.buffer);

  return new Blob(parties, { type: 'application/zip' });
}
