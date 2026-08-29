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

const { getStore } = require('@netlify/blobs');

const BEREICHE = ['personal', 'kosten', 'dienstplan'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return antwort(405, { fehler: 'Nur POST' });
  }

  let eingabe = {};
  try { eingabe = JSON.parse(event.body || '{}'); } catch (e) { /* leer lassen */ }

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

function antwort(status, koerper) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(koerper)
  };
}
