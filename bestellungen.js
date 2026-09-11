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
      const gueltige = ohneErsetzte(
        alle.filter(function (b) { return b.filiale === filiale && b.datum === deutsch; }));
      gueltige.forEach(function (b) {
          String(b.uebersicht || '').split('\n').forEach(function (zeile) {
            const s = zeile.split('\t');
            if (s.length >= 3) {
              positionen.push({ nr: s[0].trim(), bez: s[1].trim(), menge: parseInt(s[2], 10) || 0 });
            }
          });
        });
      const retourPositionen = [];
      (await ausArchiv('retouren'))
        .filter(function (r) { return r.filiale === filiale && r.datum === deutsch; })
        .forEach(function (r) {
          String(r.uebersicht || '').split('\n').forEach(function (zeile) {
            const s = zeile.split('\t');
            if (s.length >= 3) {
              retourPositionen.push({ nr: s[0].trim(), bez: s[1].trim(), menge: parseInt(s[2], 10) || 0 });
            }
          });
        });
      const zuletzt = gueltige.length
        ? gueltige.map(function (x) { return x.erstellt; }).sort().slice(-1)[0] : '';
      return antwort(200, { filiale: filiale, datum: datum,
                            positionen: positionen, retouren: retourPositionen,
                            anzahl: gueltige.length, zuletzt: zuletzt });
    } catch (fehler) {
      return antwort(502, { fehler: 'Die Lieferung konnte nicht geladen werden.' });
    }
  }

  // Alle erfassten Bestellungen und Retouren unwiderruflich löschen
  if (eingabe.aktion === 'alles-loeschen') {
    if (eingabe.bestaetigung !== 'ALLE-DATEN-LOESCHEN') {
      return antwort(400, { fehler: 'Bestätigung fehlt.' });
    }
    const chefwort = process.env.CHEF_PASSWORT;
    if (chefwort && !gleich(String(eingabe.passwort || ''), chefwort)) {
      return antwort(401, { fehler: 'Das Passwort stimmt nicht.' });
    }

    const bericht = { archiv: 0, eingaenge: 0, fehler: [] };

    // 1. Archiv leeren
    for (const name of ['bestellungen', 'retouren']) {
      try {
        const ablage = getStore(name);
        const liste = await ablage.list();
        const schluessel = (liste.blobs || []).map(function (x) { return x.key; });
        for (const k of schluessel) {
          await ablage.delete(k);
          if (k !== 'sammlung') bericht.archiv++;
        }
        await ablage.setJSON('sammlung', { eintraege: [], anzahl: 0,
                                           geaendert: new Date().toISOString() });
      } catch (fehler) {
        bericht.fehler.push(name + ': ' + fehler.message);
      }
    }

    // 2. Formulareingänge bei Netlify löschen, sonst kämen sie zurück
    const token = process.env.NETLIFY_API_TOKEN;
    const siteId = process.env.SITE_ID;
    if (token && siteId) {
      try {
        const kopf = { Authorization: 'Bearer ' + token };
        const formulare = await hole(API + '/sites/' + siteId + '/forms', kopf);
        for (const f of formulare) {
          for (let seite = 1; seite <= 10; seite++) {
            const teil = await hole(API + '/forms/' + f.id + '/submissions?per_page=100&page=' + seite, kopf);
            for (const e of teil) {
              const weg = await fetch(API + '/submissions/' + e.id, { method: 'DELETE', headers: kopf });
              if (weg.ok) bericht.eingaenge++;
            }
            if (teil.length < 100) break;
          }
        }
      } catch (fehler) {
        bericht.fehler.push('Formulare: ' + fehler.message);
      }
    }

    return antwort(200, bericht);
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
  // Die Formulareingänge werden nur gelesen, wenn FORMULARE_MITLESEN auf "ja" steht.
  // Sonst genügt das Archiv – das spart bei jedem Aufruf mehrere Anfragen an Netlify.
  const token = process.env.NETLIFY_API_TOKEN;
  const siteId = process.env.SITE_ID;
  if (token && siteId && String(process.env.FORMULARE_MITLESEN || '').toLowerCase() === 'ja') {
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
                bestellart: d.bestellart || 'neu',
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

  const bestellungen = markiereErsetzte(
    Object.keys(gefunden).map(function (k) { return gefunden[k]; }))
    .sort(function (a, b) { return String(a.erstellt) < String(b.erstellt) ? 1 : -1; });

  return antwort(200, { bestellungen: bestellungen, retouren: retouren });
};

// Eine Korrektur ersetzt alle früheren Bestellungen derselben Filiale am selben Liefertag
function markiereErsetzte(liste) {
  const gruppen = {};
  liste.forEach(function (b) {
    const schluessel = (b.filiale || '') + '|' + (b.datum || '');
    (gruppen[schluessel] = gruppen[schluessel] || []).push(b);
  });
  Object.keys(gruppen).forEach(function (k) {
    const teil = gruppen[k].sort(function (a, b) {
      return String(a.erstellt) < String(b.erstellt) ? -1 : 1;
    });
    let letzteKorrektur = -1;
    teil.forEach(function (b, i) { if (b.bestellart === 'korrektur') letzteKorrektur = i; });
    teil.forEach(function (b, i) { b.ersetzt = (i < letzteKorrektur); });
  });
  return liste;
}

function ohneErsetzte(liste) {
  return markiereErsetzte(liste).filter(function (b) { return !b.ersetzt; });
}

// Alle Einträge eines Archivs lesen.
// Zuerst die Sammeldatei – das ist ein einziger Lesevorgang statt hunderter.
async function ausArchiv(name) {
  try {
    const ablage = getStore(name);
    const sammlung = await ablage.get('sammlung', { type: 'json' });
    if (sammlung && Array.isArray(sammlung.eintraege)) {
      return sammlung.eintraege;
    }
    // Noch keine Sammeldatei: einmal alles einlesen und dabei anlegen
    return await sammlungAufbauen(name, ablage);
  } catch (fehler) {
    console.error('Archiv ' + name + ' nicht lesbar:', fehler.message);
    return [];
  }
}

// Liest jeden Eintrag einzeln und legt daraus die Sammeldatei an
async function sammlungAufbauen(name, ablage) {
  const treffer = [];
  try {
    const liste = await ablage.list();
    const schluessel = (liste.blobs || []).map(function (b) { return b.key; })
      .filter(function (k) { return k !== 'sammlung' && k.indexOf('probe/') !== 0; }).sort();
    for (let i = 0; i < schluessel.length; i += 25) {
      const teil = schluessel.slice(i, i + 25);
      const daten = await Promise.all(teil.map(function (k) {
        return ablage.get(k, { type: 'json' }).catch(function () { return null; });
      }));
      daten.forEach(function (b) { if (b && b.id) treffer.push(b); });
    }
    treffer.sort(function (a, b) { return String(a.erstellt) < String(b.erstellt) ? 1 : -1; });
    await ablage.setJSON('sammlung', {
      eintraege: treffer, anzahl: treffer.length, geaendert: new Date().toISOString()
    });
  } catch (fehler) {
    console.error('Sammeldatei ' + name + ' nicht aufgebaut:', fehler.message);
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
