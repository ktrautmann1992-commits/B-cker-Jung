// netlify/functions/bestellungen.js
//
// Liefert die Bestellungen an die Chef-Ansicht.
//
// Quelle 1: das dauerhafte Archiv in Netlify Blobs, das submission-created.js
//           bei jeder neuen Bestellung füllt. Dafür ist kein Token nötig.
// Quelle 2 (optional): die Formulareingänge über die Netlify-API. Nur aktiv,
//           wenn NETLIFY_API_TOKEN gesetzt ist – nützlich für Bestellungen,
//           die vor dem Archiv eingegangen sind.
//
// Optionale Umgebungsvariablen:
//   CHEF_PASSWORT      schaltet die Passwortabfrage ein
//   NETLIFY_API_TOKEN  bindet zusätzlich die alten Formulareingänge ein
//   FORM_NAME          Standard: "bestellung"

const blobs = require('@netlify/blobs');

function getStore(name) {
  try {
    return blobs.getStore(name);
  } catch (fehler) {
    return blobs.getStore({
      name: name,
      siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN
    });
  }
}

const API = 'https://api.netlify.com/api/v1';

exports.handler = async function (event) {
  // Selbstauskunft im Browser: prüft Schreiben, Lesen und den Bestand
  if (event.httpMethod === 'GET') {
    const bericht = { funktion: 'bestellungen', node: process.version,
                      siteId: process.env.SITE_ID ? 'vorhanden' : 'fehlt',
                      blobsUmgebung: process.env.NETLIFY_BLOBS_CONTEXT ? 'vorhanden' : 'fehlt' };
    try {
      const ablage = getStore('bestellungen');
      await ablage.setJSON('probe/test', { zeit: new Date().toISOString() });
      const zurueck = await ablage.get('probe/test', { type: 'json' });
      bericht.schreibenLesen = zurueck ? 'funktioniert' : 'liest nichts zurueck';
      const liste = await ablage.list();
      const schluessel = (liste.blobs || []).map(function (x) { return x.key; });
      bericht.bestellungenImArchiv = schluessel.length;
      bericht.schluessel = schluessel.slice(0, 10);
    } catch (fehler) {
      bericht.schreibenLesen = 'FEHLER';
      bericht.meldung = fehler.message;
      bericht.name = fehler.name;
    }
    try {
      const r = getStore('retouren');
      const l = await r.list();
      bericht.retourenImArchiv = (l.blobs || []).length;
    } catch (fehler) {
      bericht.retourenImArchiv = 'FEHLER: ' + fehler.message;
    }
    return antwort(200, bericht);
  }

  if (event.httpMethod !== 'POST') {
    return antwort(405, { fehler: 'Nur POST' });
  }

  let eingabe = {};
  try { eingabe = JSON.parse(event.body || '{}'); } catch (e) { /* leer lassen */ }

  // Abfrage der Filiale: Was wurde an diesem Tag geliefert?
  // Ohne Passwort, weil die Filiale nur ihre eigene Lieferung sieht.
  if (eingabe.aktion === 'tagesbestellung') {
    const filiale = String(eingabe.filiale || '');
    const datum = String(eingabe.datum || '');
    if (!filiale || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
      return antwort(400, { fehler: 'Filiale und Datum im Format JJJJ-MM-TT senden.' });
    }
    try {
      const alle = await ausArchiv('bestellungen');
      const deutsch = datum.split('-').reverse().join('.');
      const positionen = [];
      alle.filter(function (b) { return b.filiale === filiale && b.datum === deutsch; })
        .forEach(function (b) {
          String(b.uebersicht || '').split('\n').forEach(function (zeile) {
            const s = zeile.split('\t');
            if (s.length >= 3) {
              positionen.push({ nr: s[0].trim(), bez: s[1].trim(), menge: parseInt(s[2], 10) || 0 });
            }
          });
        });
      return antwort(200, { filiale: filiale, datum: datum, positionen: positionen });
    } catch (fehler) {
      return antwort(502, { fehler: 'Die Lieferung konnte nicht geladen werden.' });
    }
  }

  const erwartet = process.env.CHEF_PASSWORT;
  if (erwartet) {
    if (!eingabe.passwort || !gleich(String(eingabe.passwort), erwartet)) {
      return antwort(401, { fehler: 'Das Passwort stimmt nicht.' });
    }
  }

  const gefunden = {};
  (await ausArchiv('bestellungen')).forEach(function (b) { gefunden[b.id] = b; });
  const retouren = await ausArchiv('retouren');

  // Zusätzlich die Formulareingänge, falls ein Token hinterlegt ist
  const token = process.env.NETLIFY_API_TOKEN;
  const siteId = process.env.SITE_ID;
  if (token && siteId) {
    try {
      const kopf = { Authorization: 'Bearer ' + token };
      const formulare = await hole(API + '/sites/' + siteId + '/forms', kopf);
      const name = process.env.FORM_NAME || 'bestellung';
      const formular = formulare.find(function (f) { return f.name === name; });
      if (formular) {
        for (let seite = 1; seite <= 10; seite++) {
          const teil = await hole(
            API + '/forms/' + formular.id + '/submissions?per_page=100&page=' + seite, kopf);
          teil.forEach(function (e) {
            const d = e.data || {};
            if (!gefunden[e.id]) {
              gefunden[e.id] = {
                id: e.id, erstellt: e.created_at,
                filiale: d.filiale || '', datum: d.datum || '',
                besteller: d.besteller || '', positionen: d.positionen || '0',
                stueck: d.stueck || '0', warenwert: d.warenwert || '',
                bemerkung: d.bemerkung || '', uebersicht: d.uebersicht || '',
                csv: dateiUrl(d.csv), pdf: dateiUrl(d.pdf)
              };
            }
          });
          if (teil.length < 100) break;
        }
      }
    } catch (fehler) {
      console.error('Formulareingänge nicht lesbar:', fehler.message);
    }
  }

  const bestellungen = Object.keys(gefunden).map(function (k) { return gefunden[k]; })
    .sort(function (a, b) { return String(a.erstellt) < String(b.erstellt) ? 1 : -1; });

  return antwort(200, { bestellungen: bestellungen, retouren: retouren });
};

// Alle Einträge eines Archivs lesen
async function ausArchiv(name) {
  const treffer = [];
  try {
    const ablage = getStore(name);
    const liste = await ablage.list();
    const schluessel = (liste.blobs || []).map(function (b) { return b.key; }).sort();
    for (let i = 0; i < schluessel.length; i += 25) {
      const teil = schluessel.slice(i, i + 25);
      const daten = await Promise.all(teil.map(function (k) {
        return ablage.get(k, { type: 'json' }).catch(function () { return null; });
      }));
      daten.forEach(function (b) { if (b && b.id) treffer.push(b); });
    }
  } catch (fehler) {
    console.error('Archiv ' + name + ' nicht lesbar:', fehler.message);
  }
  return treffer;
}

async function hole(url, kopf) {
  const a = await fetch(url, { headers: kopf });
  if (!a.ok) throw new Error('Status ' + a.status);
  return a.json();
}

function dateiUrl(wert) {
  if (!wert) return '';
  if (typeof wert === 'string') return wert;
  return wert.url || '';
}

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
