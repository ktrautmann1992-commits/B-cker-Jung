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

const blobs = require('@netlify/blobs');

// Erst der normale Weg, sonst ausdrücklich mit Site-ID und Token
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

exports.handler = async function (event) {
  // Selbstauskunft: im Browser aufrufbar, prüft ob die Ablage funktioniert
  if (event.httpMethod === 'GET') {
    const bericht = {
      funktion: 'umsatz',
      node: process.version,
      siteId: process.env.SITE_ID ? 'vorhanden' : 'fehlt',
      blobsToken: process.env.NETLIFY_BLOBS_CONTEXT ? 'vorhanden' : 'fehlt',
      ablage: 'unbekannt'
    };
    try {
      const probe = getStore('tagesumsatz');
      await probe.setJSON('probe-test', { zeit: new Date().toISOString() });
      const zurueck = await probe.get('probe-test', { type: 'json' });
      bericht.ablage = zurueck ? 'funktioniert' : 'schreibt, liest aber nichts';
    } catch (fehler) {
      bericht.ablage = 'FEHLER';
      bericht.meldung = fehler.message;
      bericht.name = fehler.name;
    }
    return antwort(200, bericht);
  }

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

  // Meldung einer einzelnen Filiale (aus dem Formular der Filiale)
  if (eingabe.aktion === 'filiale') {
    const filiale = String(eingabe.filiale || '').slice(0, 80);
    const tag = String(eingabe.datum || '');
    const betrag = Math.round((Number(eingabe.betrag) || 0) * 100) / 100;
    if (!filiale || !istDatum(tag) || betrag <= 0) {
      return antwort(400, { fehler: 'Filiale, Datum und Betrag werden benötigt.' });
    }
    try {
      const ablage = getStore('tagesumsatz');
      const vorhanden = (await ablage.get(tag, { type: 'json' })) || {};
      const umsaetze = vorhanden.umsaetze || {};
      const hinweise = vorhanden.hinweise || {};
      const meldungen = vorhanden.meldungen || {};
      umsaetze[filiale] = betrag;
      meldungen[filiale] = {
        melder: String(eingabe.melder || '').slice(0, 80),
        zeit: new Date().toISOString()
      };
      await ablage.setJSON(tag, { datum: tag, umsaetze: umsaetze, hinweise: hinweise,
                                  meldungen: meldungen, geaendert: new Date().toISOString() });
      return antwort(200, { gespeichert: true, filiale: filiale, betrag: betrag });
    } catch (fehler) {
      return antwort(502, { fehler: 'Der Umsatz konnte nicht gespeichert werden: ' + fehler.message });
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
      const alt = (await ablage.get(datum, { type: 'json' }).catch(function () { return null; })) || {};
      await ablage.setJSON(datum, { datum: datum, umsaetze: sauber, hinweise: hinweise,
                                    meldungen: alt.meldungen || {},
                                    geaendert: new Date().toISOString() });
      return antwort(200, { gespeichert: true, umsaetze: sauber, hinweise: hinweise });
    }

    const daten = await ablage.get(datum, { type: 'json' });
    return antwort(200, { umsaetze: (daten && daten.umsaetze) || {},
                          hinweise: (daten && daten.hinweise) || {},
                          meldungen: (daten && daten.meldungen) || {} });
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
