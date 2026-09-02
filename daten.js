// netlify/functions/daten.js
//
// Ablage für Personalstamm, Filialkosten und Dienstpläne.
// Gespeichert wird in Netlify Blobs, dafür ist keine Datenbank nötig.
//
// Voraussetzung: "@netlify/blobs" steht in der package.json.
//
// Anfragen (POST):
//   { "aktion": "lesen",     "bereich": "personal",   "schluessel": "alle" }
//   { "aktion": "speichern", "bereich": "kosten",     "schluessel": "alle", "inhalt": { ... } }
//   { "aktion": "liste",     "bereich": "dienstplan" }

const blobs = require('@netlify/blobs');

function getStore(name) {
  // Steht die Blobs-Umgebung bereit, reicht der Name
  if (process.env.NETLIFY_BLOBS_CONTEXT) return blobs.getStore(name);

  // Sonst Zugang ausdrücklich mitgeben
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) {
    throw new Error('Der Zugang zur Ablage fehlt. Bitte NETLIFY_API_TOKEN in den ' +
                    'Umgebungsvariablen des Projekts eintragen.');
  }
  return blobs.getStore({ name: name, siteID: siteID, token: token, consistency: 'strong' });
}

const BEREICHE = ['personal', 'kosten', 'dienstplan', 'kunden'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return antwort(405, { fehler: 'Nur POST' });
  }

  let eingabe = {};
  try { eingabe = JSON.parse(event.body || '{}'); } catch (e) { /* leer lassen */ }

  // Passwortprüfung, sobald CHEF_PASSWORT gesetzt ist
  const erwartet = process.env.CHEF_PASSWORT;
  if (erwartet) {
    if (!eingabe.passwort || !gleich(String(eingabe.passwort), erwartet)) {
      return antwort(401, { fehler: 'Das Passwort stimmt nicht.' });
    }
  }

  // Anmeldung eines Kunden: prüft E-Mail und Passwort, gibt nur die Rechte zurück
  if (eingabe.aktion === 'kundenlogin') {
    const email = String(eingabe.email || '').trim().toLowerCase();
    const passwort = String(eingabe.passwort || '');
    if (!email || !passwort) {
      return antwort(400, { fehler: 'E-Mail und Passwort werden benötigt.' });
    }
    try {
      const ablage = getStore('chefdaten');
      const daten = (await ablage.get('kunden/alle', { type: 'json' })) || {};
      const treffer = (daten.kunden || []).filter(function (k) {
        return String(k.email || '').trim().toLowerCase() === email;
      })[0];
      if (!treffer || !gleich(String(treffer.passwort || ''), passwort)) {
        return antwort(401, { fehler: 'E-Mail oder Passwort stimmt nicht.' });
      }
      if (treffer.aktiv === false) {
        return antwort(403, { fehler: 'Dieser Zugang ist stillgelegt.' });
      }
      return antwort(200, {
        kunde: {
          id: treffer.id,
          name: treffer.name || '',
          email: treffer.email || '',
          darfBestellen: treffer.darfBestellen !== false,
          darfRetoure: treffer.darfRetoure === true
        }
      });
    } catch (fehler) {
      return antwort(502, { fehler: 'Die Anmeldung ist gerade nicht möglich: ' + fehler.message });
    }
  }

  const bereich = String(eingabe.bereich || '');
  if (BEREICHE.indexOf(bereich) === -1) {
    return antwort(400, { fehler: 'Unbekannter Bereich. Erlaubt sind: ' + BEREICHE.join(', ') + '.' });
  }

  try {
    const ablage = getStore('chefdaten');

    if (eingabe.aktion === 'liste') {
      const liste = await ablage.list({ prefix: bereich + '/' });
      const schluessel = (liste.blobs || []).map(function (b) { return b.key; }).sort();
      const eintraege = {};
      for (let i = 0; i < schluessel.length; i += 20) {
        const teil = schluessel.slice(i, i + 20);
        const daten = await Promise.all(teil.map(function (k) {
          return ablage.get(k, { type: 'json' }).catch(function () { return null; });
        }));
        teil.forEach(function (k, n) {
          if (daten[n]) eintraege[k.slice(bereich.length + 1)] = daten[n];
        });
      }
      return antwort(200, { bereich: bereich, eintraege: eintraege });
    }

    const schluessel = String(eingabe.schluessel || 'alle');
    if (!/^[\w.-]{1,60}$/.test(schluessel)) {
      return antwort(400, { fehler: 'Ungültiger Schlüssel.' });
    }
    const pfad = bereich + '/' + schluessel;

    if (eingabe.aktion === 'speichern') {
      const inhalt = eingabe.inhalt || {};
      const roh = JSON.stringify(inhalt);
      if (roh.length > 2000000) {
        return antwort(413, { fehler: 'Der Datensatz ist zu groß.' });
      }
      await ablage.setJSON(pfad, inhalt);
      return antwort(200, { gespeichert: true });
    }

    const inhalt = await ablage.get(pfad, { type: 'json' });
    return antwort(200, { bereich: bereich, schluessel: schluessel, inhalt: inhalt || null });
  } catch (fehler) {
    return antwort(502, { fehler: 'Die Daten konnten nicht verarbeitet werden: ' + fehler.message });
  }
};

function gleich(a, b) {
  if (a.length !== b.length) return false;
  let unterschied = 0;
  for (let i = 0; i < a.length; i++) unterschied |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return unterschied === 0;
}

// Vergleich mit gleichbleibender Laufzeit
function gleich(a, b) {
  if (a.length !== b.length) return false;
  let unterschied = 0;
  for (let i = 0; i < a.length; i++) unterschied |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return unterschied === 0;
}

function antwort(status, koerper) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(koerper)
  };
}
