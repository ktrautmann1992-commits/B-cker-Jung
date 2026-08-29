// netlify/functions/umsatz.js
//
// Speichert die Tagesumsätze, die der Chef je Filiale einträgt, und liest sie wieder aus.
// Ablage: Netlify Blobs – dafür ist keine Datenbank nötig.
//
// Voraussetzung: In der package.json muss "@netlify/blobs" als Abhängigkeit stehen.
//
// Anfrage (POST):
//   { "aktion": "lesen",      "datum": "2026-08-28" }
//   { "aktion": "speichern",  "datum": "2026-08-28", "umsaetze": { "Kusel": 1240.50 } }

const { getStore } = require('@netlify/blobs');

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

  // Ganze Zeiträume für die Auswertung (Quartal, Jahr)
  if (eingabe.aktion === 'zeitraum') {
    const von = String(eingabe.von || ''), bis = String(eingabe.bis || '');
    if (!istDatum(von) || !istDatum(bis)) {
      return antwort(400, { fehler: 'Bitte von und bis im Format JJJJ-MM-TT senden.' });
    }
    try {
      const ablage = getStore('tagesumsatz');
      const liste = await ablage.list();
      const schluessel = (liste.blobs || [])
        .map(function (b) { return b.key; })
        .filter(function (k) { return istDatum(k) && k >= von && k <= bis; })
        .sort();

      const tage = {};
      for (let i = 0; i < schluessel.length; i += 20) {
        const teil = schluessel.slice(i, i + 20);
        const daten = await Promise.all(teil.map(function (k) {
          return ablage.get(k, { type: 'json' }).catch(function () { return null; });
        }));
        teil.forEach(function (k, n) {
          if (daten[n] && daten[n].umsaetze) tage[k] = daten[n].umsaetze;
        });
      }
      return antwort(200, { von: von, bis: bis, tage: tage });
    } catch (fehler) {
      return antwort(502, { fehler: 'Die Auswertung konnte nicht geladen werden: ' + fehler.message });
    }
  }

  const datum = String(eingabe.datum || '');
  if (!istDatum(datum)) {
    return antwort(400, { fehler: 'Bitte ein Datum im Format JJJJ-MM-TT senden.' });
  }

  try {
    const ablage = getStore('tagesumsatz');

    if (eingabe.aktion === 'speichern') {
      const roh = eingabe.umsaetze || {};
      const sauber = {};
      Object.keys(roh).forEach(function (ort) {
        const zahl = Number(roh[ort]);
        if (isFinite(zahl) && zahl > 0) sauber[String(ort).slice(0, 80)] = Math.round(zahl * 100) / 100;
      });
      const hinweise = {};
      Object.keys(eingabe.hinweise || {}).forEach(function (ort) {
        if (roh[ort] !== undefined || sauber[ort] !== undefined) hinweise[String(ort).slice(0, 80)] = true;
      });
      await ablage.setJSON(datum, { datum: datum, umsaetze: sauber, hinweise: hinweise,
                                    geaendert: new Date().toISOString() });
      return antwort(200, { gespeichert: true, umsaetze: sauber, hinweise: hinweise });
    }

    const daten = await ablage.get(datum, { type: 'json' });
    return antwort(200, { umsaetze: (daten && daten.umsaetze) || {},
                          hinweise: (daten && daten.hinweise) || {} });
  } catch (fehler) {
    return antwort(502, { fehler: 'Die Umsätze konnten nicht gespeichert werden: ' + fehler.message });
  }
};

function istDatum(wert) {
  return /^\d{4}-\d{2}-\d{2}$/.test(wert);
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
