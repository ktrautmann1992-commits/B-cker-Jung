// touren.js
//
// Tourenplanung für die Bäckerei Jung.
//
// Aufgaben dieser Funktion:
//   1. Adressen in Koordinaten umwandeln (und das Ergebnis dauerhaft merken,
//      damit für dieselbe Adresse nie zweimal nachgefragt wird)
//   2. Fahrzeiten und Kilometer zwischen allen Punkten besorgen
//   3. Die Stopps so auf die Touren verteilen, dass möglichst wenig
//      gefahren wird und möglichst wenige Touren nötig sind
//
// Gefahren wird immer von der Produktion aus und wieder dorthin zurück.
//
// Mit hinterlegtem ORS_API_KEY werden echte Straßenrouten gerechnet.
// Ohne Schlüssel rechnet die Funktion mit Luftlinie und Zuschlag – das
// ist eine Schätzung und wird in der Antwort auch so gekennzeichnet.
//
// Anfragen (POST):
//   { "aktion": "planen",   "stopps": [ ... ], "abfahrten": ["02:30"], ... }
//   { "aktion": "pruefen",  "adressen": ["..."] }
//   { "aktion": "lage" }

const blobs = require('@netlify/blobs');
const crypto = require('crypto');

const PRODUKTION = 'Walther-Eucken-Straße 11, 66877 Ramstein-Miesenbach';

function getStore(name) {
  if (process.env.NETLIFY_BLOBS_CONTEXT) return blobs.getStore(name);
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) {
    throw new Error('Der Zugang zur Ablage fehlt. Bitte NETLIFY_API_TOKEN in den ' +
                    'Umgebungsvariablen des Projekts eintragen.');
  }
  return blobs.getStore({ name: name, siteID: siteID, token: token, consistency: 'strong' });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    return antwort(200, {
      bereit: true,
      routenschluessel: !!process.env.ORS_API_KEY,
      produktion: PRODUKTION,
      hinweis: process.env.ORS_API_KEY
        ? 'Echte Straßenrouten über OpenRouteService.'
        : 'Noch kein ORS_API_KEY hinterlegt – es wird geschätzt.'
    });
  }
  if (event.httpMethod !== 'POST') return antwort(405, { fehler: 'Nur POST' });

  let eingabe = {};
  try { eingabe = JSON.parse(event.body || '{}'); } catch (e) { /* leer lassen */ }

  const erwartet = process.env.CHEF_PASSWORT;
  if (erwartet && !gleich(String(eingabe.passwort || ''), erwartet)) {
    return antwort(401, { fehler: 'Das Passwort stimmt nicht.' });
  }

  try {
    if (eingabe.aktion === 'lage') {
      return antwort(200, {
        routenschluessel: !!process.env.ORS_API_KEY,
        produktion: PRODUKTION
      });
    }

    if (eingabe.aktion === 'pruefen') {
      const liste = (eingabe.adressen || []).map(String).slice(0, 60);
      const punkte = await orteHolen([PRODUKTION].concat(liste));
      return antwort(200, {
        produktion: punkte[0] ? { gefunden: true, bezeichnung: punkte[0].label } : { gefunden: false },
        adressen: liste.map(function (a, i) {
          const p = punkte[i + 1];
          return { adresse: a, gefunden: !!p, bezeichnung: p ? p.label : '' };
        })
      });
    }

    if (eingabe.aktion === 'planen') return await planen(eingabe);
    if (eingabe.aktion === 'nachrechnen') return await nachrechnen(eingabe);

    return antwort(400, { fehler: 'Unbekannte Aktion.' });
  } catch (fehler) {
    return antwort(502, { fehler: 'Die Tour konnte nicht berechnet werden: ' + fehler.message });
  }
};

// ---------------------------------------------------------------- Planen

// Liest die Stopps aus der Anfrage und bringt sie in eine einheitliche Form
function stoppsLesen(roh) {
  return roh.map(function (s, i) {
    const feste = parseInt(s.festeTour, 10);
    return {
      schluessel: String(s.schluessel || ('s' + i)),
      name: String(s.name || ('Stopp ' + (i + 1))).slice(0, 80),
      adresse: String(s.adresse || '').trim(),
      art: s.art === 'kunde' ? 'kunde' : 'filiale',
      entladen: begrenzt(zahl(s.entladen, 6), 0, 120),
      menge: Math.max(0, zahl(s.menge, 0)),
      festeTour: (feste >= 1 && feste <= 3) ? feste : 0,
      fahrzeug: begrenzt(parseInt(s.fahrzeug, 10) || 1, 1, 3),
      spaetestens: minuten(s.spaetestens)
    };
  }).filter(function (s) { return s.adresse; });
}

// Adressen suchen und die Fahrzeiten zwischen allen Punkten besorgen
async function vorbereiten(stopps) {
  const orte = await orteHolen([PRODUKTION].concat(stopps.map(function (s) { return s.adresse; })));
  if (!orte[0]) return { fehler: 'Die Adresse der Produktion wurde nicht gefunden.' };

  const fehlend = [];
  const gute = [];
  stopps.forEach(function (s, i) {
    if (orte[i + 1]) { s.ort = orte[i + 1]; gute.push(s); }
    else fehlend.push({ name: s.name, adresse: s.adresse });
  });
  if (!gute.length) {
    return {
      fehler: 'Keine der Adressen wurde gefunden. Bitte Straße, Hausnummer und Ort prüfen.',
      fehlend: fehlend
    };
  }

  const punkte = [orte[0]].concat(gute.map(function (s) { return s.ort; }));
  const gitter = await gitterHolen(punkte);
  return { gute: gute, fehlend: fehlend, gitter: gitter };
}

// Aus fertigen Routen die Zeiten je Stopp ausrechnen
function ausgeben(routen, abfahrten, kapazitaeten, gute, gitter, zusatz) {
  const touren = [];
  let gesamtMin = 0;

  routen.forEach(function (route, v) {
    if (!route.length) return;
    let t = abfahrten[v];
    let vorher = 0;
    let ladung = 0;

    const halte = route.map(function (idx) {
      const s = gute[idx];
      const fahrMin = gitter.dauer[vorher][idx + 1];
      t += fahrMin;
      const ankunft = t;
      t += s.entladen;
      ladung += s.menge;
      vorher = idx + 1;
      return {
        schluessel: s.schluessel,
        name: s.name,
        adresse: s.adresse,
        art: s.art,
        entladen: s.entladen,
        menge: s.menge,
        fahrzeit: Math.round(fahrMin),
        ankunft: uhr(ankunft),
        weiter: uhr(t),
        spaetestens: s.spaetestens === null ? '' : uhr(s.spaetestens),
        zuSpaet: s.spaetestens !== null && ankunft > s.spaetestens + 1
      };
    });

    const rueckMin = gitter.dauer[vorher][0];
    t += rueckMin;
    gesamtMin += t - abfahrten[v];
    const kap = kapazitaeten[v] || 0;
    touren.push({
      nr: v + 1,                 // die Nummer gehört zum Fahrzeug, nicht zur Reihenfolge
      fahrzeug: v + 1,
      abfahrt: uhr(abfahrten[v]),
      zurueck: uhr(t),
      dauer: Math.round(t - abfahrten[v]),
      rueckfahrt: { fahrzeit: Math.round(rueckMin) },
      ladung: runde(ladung, 1),
      kapazitaet: kap,
      ueberladen: kap > 0 && ladung > kap + 0.001,
      stopps: halte
    });
  });

  return antwort(200, Object.assign({
    produktion: PRODUKTION,
    quelle: gitter.quelle,
    geschaetzt: gitter.quelle !== 'ors',
    touren: touren,
    gesamtMin: Math.round(gesamtMin),
    gerechnet: new Date().toISOString()
  }, zusatz || {}));
}

function einstellungenLesen(eingabe) {
  const maxTouren = begrenzt(parseInt(eingabe.maxTouren, 10) || 3, 1, 3);
  const abfahrten = [];
  const kapazitaeten = [];
  for (let v = 0; v < 3; v++) {
    const t = minuten((eingabe.abfahrten || [])[v]);
    abfahrten.push(t === null ? 150 : t);                      // Standard: 2:30 Uhr
    kapazitaeten.push(Math.max(0, zahl((eingabe.kapazitaeten || [])[v], 0)));
  }
  return { maxTouren: maxTouren, abfahrten: abfahrten, kapazitaeten: kapazitaeten,
           zurueckBis: minuten(eingabe.zurueckBis) };
}

async function planen(eingabe) {
  const roh = Array.isArray(eingabe.stopps) ? eingabe.stopps : [];
  if (!roh.length) return antwort(400, { fehler: 'Es ist kein Stopp ausgewählt.' });
  if (roh.length > 45) return antwort(400, { fehler: 'Mehr als 45 Stopps sind nicht vorgesehen.' });

  const stopps = stoppsLesen(roh);
  if (!stopps.length) return antwort(400, { fehler: 'Zu keinem Stopp ist eine Adresse hinterlegt.' });

  const e = einstellungenLesen(eingabe);
  const vor = await vorbereiten(stopps);
  if (vor.fehler) return antwort(502, { fehler: vor.fehler, fehlend: vor.fehlend || [] });

  const aufgabe = {
    anzahl: vor.gute.length,
    dauer: vor.gitter.dauer,
    weg: vor.gitter.weg,
    dienst: vor.gute.map(function (s) { return s.entladen; }),
    frist: vor.gute.map(function (s) { return s.spaetestens; }),
    menge: vor.gute.map(function (s) { return s.menge; }),
    feste: vor.gute.map(function (s) { return s.festeTour; }),
    abfahrten: e.abfahrten,
    kapazitaeten: e.kapazitaeten,
    zurueckBis: e.zurueckBis
  };

  // So wenige Touren wie möglich: erst eine versuchen, dann zwei, dann drei
  let ergebnis = null;
  for (let k = 1; k <= e.maxTouren; k++) {
    ergebnis = verteilen(aufgabe, k);
    if (ergebnis) break;
  }

  // Geht es mit den Uhrzeiten nicht auf, noch einmal ohne Fristen rechnen
  const knapp = !ergebnis;
  if (!ergebnis) {
    const ohne = Object.assign({}, aufgabe, {
      frist: vor.gute.map(function () { return null; }), zurueckBis: null
    });
    for (let k = 1; k <= e.maxTouren; k++) {
      ergebnis = verteilen(ohne, k);
      if (ergebnis) break;
    }
  }

  // Passt die Ladung nirgends hinein, zuletzt ohne Kapazitäten rechnen
  const platzt = !ergebnis;
  if (!ergebnis) {
    const ohne = Object.assign({}, aufgabe, {
      frist: vor.gute.map(function () { return null; }), zurueckBis: null,
      kapazitaeten: [0, 0, 0]
    });
    for (let k = 1; k <= e.maxTouren; k++) {
      ergebnis = verteilen(ohne, k);
      if (ergebnis) break;
    }
  }
  if (!ergebnis) return antwort(500, { fehler: 'Die Stopps ließen sich nicht aufteilen.' });

  return ausgeben(ergebnis.routen, e.abfahrten, e.kapazitaeten, vor.gute, vor.gitter, {
    fehlend: vor.fehlend,
    fristenGesprengt: knapp,
    ladungGesprengt: platzt
  });
}

// Der Chef hat von Hand umsortiert: nur die Zeiten neu ausrechnen
async function nachrechnen(eingabe) {
  const gruppen = Array.isArray(eingabe.touren) ? eingabe.touren : [];
  const flach = [];
  gruppen.forEach(function (g, i) {
    const v = begrenzt(parseInt(g.fahrzeug, 10) || (i + 1), 1, 3);
    (g.stopps || []).forEach(function (s) {
      flach.push(Object.assign({}, s, { fahrzeug: v }));
    });
  });
  if (!flach.length) return antwort(400, { fehler: 'Es ist kein Stopp vorhanden.' });

  const stopps = stoppsLesen(flach);
  if (!stopps.length) return antwort(400, { fehler: 'Zu keinem Stopp ist eine Adresse hinterlegt.' });

  const e = einstellungenLesen(eingabe);
  const vor = await vorbereiten(stopps);
  if (vor.fehler) return antwort(502, { fehler: vor.fehler, fehlend: vor.fehlend || [] });

  // Die Reihenfolge bleibt genau so, wie sie hereingereicht wurde
  const routen = [[], [], []];
  vor.gute.forEach(function (s, i) { routen[s.fahrzeug - 1].push(i); });

  return ausgeben(routen, e.abfahrten, e.kapazitaeten, vor.gute, vor.gitter, {
    fehlend: vor.fehlend, vonHand: true
  });
}

// ------------------------------------------------- Stopps auf Touren verteilen
//
// Erst werden die Stopps eingefügt, wo sie am wenigsten Umweg kosten.
// Danach wird so lange getauscht und verschoben, wie es kürzer wird.

function verteilen(a, k) {
  const routen = [];
  for (let v = 0; v < k; v++) routen.push([]);

  // Reihenfolge der Einfügung: knappe Fristen zuerst, dann die weit entfernten
  const reihe = [];
  for (let i = 0; i < a.anzahl; i++) reihe.push(i);
  reihe.sort(function (x, y) {
    const fx = a.frist[x], fy = a.frist[y];
    if (fx !== null && fy !== null && fx !== fy) return fx - fy;
    if (fx !== null && fy === null) return -1;
    if (fx === null && fy !== null) return 1;
    const mx = a.menge[x] || 0, my = a.menge[y] || 0;
    if (mx !== my) return my - mx;
    return a.dauer[0][y + 1] - a.dauer[0][x + 1];
  });

  for (let n = 0; n < reihe.length; n++) {
    const idx = reihe[n];
    let bestV = -1, bestP = -1, bestZu = Infinity;
    for (let v = 0; v < k; v++) {
      if (a.feste[idx] && a.feste[idx] !== v + 1) continue;   // der Chef hat es festgelegt
      const vorher = kosten(a, routen[v], v);
      for (let p = 0; p <= routen[v].length; p++) {
        const neu = routen[v].slice();
        neu.splice(p, 0, idx);
        const nachher = kosten(a, neu, v);
        if (nachher === null) continue;
        const zu = nachher - (vorher === null ? 0 : vorher);
        if (zu < bestZu - 0.0001) { bestZu = zu; bestV = v; bestP = p; }
      }
    }
    if (bestV < 0) return null;   // passt mit k Touren nicht
    routen[bestV].splice(bestP, 0, idx);
  }

  // Verbessern
  for (let runde = 0; runde < 80; runde++) {
    let besser = false;

    // a) einzelne Stopps verschieben
    for (let v = 0; v < k; v++) {
      for (let p = 0; p < routen[v].length; p++) {
        const idx = routen[v][p];
        const ohne = routen[v].slice(); ohne.splice(p, 1);
        const alt = kosten(a, routen[v], v);
        const ohneK = kosten(a, ohne, v);
        if (alt === null || ohneK === null) continue;
        let bestV = -1, bestP = -1, bestGewinn = 0.0001;
        for (let w = 0; w < k; w++) {
          if (a.feste[idx] && a.feste[idx] !== w + 1) continue;
          const basis = w === v ? ohne : routen[w];
          const basisK = kosten(a, basis, w);
          if (basisK === null) continue;
          for (let q = 0; q <= basis.length; q++) {
            if (w === v && q === p) continue;
            const neu = basis.slice(); neu.splice(q, 0, idx);
            const neuK = kosten(a, neu, w);
            if (neuK === null) continue;
            const gewinn = w === v
              ? alt - neuK
              : (alt - ohneK) + (basisK - neuK);
            if (gewinn > bestGewinn) { bestGewinn = gewinn; bestV = w; bestP = q; }
          }
        }
        if (bestV >= 0) {
          if (bestV === v) {
            routen[v] = ohne.slice();
            routen[v].splice(bestP > p ? bestP - 1 : bestP, 0, idx);
          } else {
            routen[v] = ohne;
            routen[bestV].splice(bestP, 0, idx);
          }
          besser = true;
          break;
        }
      }
      if (besser) break;
    }
    if (besser) continue;

    // b) Abschnitte innerhalb einer Tour umdrehen
    for (let v = 0; v < k && !besser; v++) {
      const r = routen[v];
      const alt = kosten(a, r, v);
      if (alt === null) continue;
      for (let i = 0; i < r.length - 1 && !besser; i++) {
        for (let j = i + 1; j < r.length; j++) {
          const neu = r.slice(0, i).concat(r.slice(i, j + 1).reverse(), r.slice(j + 1));
          const neuK = kosten(a, neu, v);
          if (neuK !== null && neuK < alt - 0.0001) {
            routen[v] = neu; besser = true; break;
          }
        }
      }
    }
    if (!besser) break;
  }

  let summe = 0;
  for (let v = 0; v < k; v++) {
    const c = kosten(a, routen[v], v);
    if (c === null) return null;
    summe += c;
  }
  return { routen: routen, kosten: summe };
}

// Kosten einer Route: reine Fahrminuten, Kilometer nur als feiner Ausschlag.
// null bedeutet: so geht es zeitlich nicht.
function kosten(a, route, v) {
  if (!route.length) return 0;

  // Passt die Ware überhaupt ins Fahrzeug?
  const kap = (a.kapazitaeten || [])[v] || 0;
  if (kap > 0) {
    let ladung = 0;
    for (let n = 0; n < route.length; n++) ladung += a.menge[route[n]] || 0;
    if (ladung > kap + 0.001) return null;
  }

  let t = a.abfahrten[v];
  let fahrt = 0, km = 0, vorher = 0;
  for (let n = 0; n < route.length; n++) {
    const idx = route[n];
    const d = a.dauer[vorher][idx + 1];
    t += d; fahrt += d; km += a.weg[vorher][idx + 1];
    if (a.frist[idx] !== null && t > a.frist[idx] + 1) return null;
    t += a.dienst[idx];
    vorher = idx + 1;
  }
  const zurueck = a.dauer[vorher][0];
  t += zurueck; fahrt += zurueck; km += a.weg[vorher][0];
  if (a.zurueckBis !== null && t > a.zurueckBis + 1) return null;
  return fahrt + km * 0.01;
}

// ---------------------------------------------------------- Adressen

async function orteHolen(adressen) {
  let ablage = null;
  try { ablage = getStore('chefdaten'); } catch (e) { /* ohne Merkzettel weiter */ }

  const ergebnis = new Array(adressen.length).fill(null);
  const offen = [];

  for (let i = 0; i < adressen.length; i++) {
    const a = saubere(adressen[i]);
    if (!a) continue;
    const pfad = 'geo/' + crypto.createHash('sha1').update(a.toLowerCase()).digest('hex').slice(0, 24);
    let merk = null;
    if (ablage) { try { merk = await ablage.get(pfad, { type: 'json' }); } catch (e) { /* egal */ } }
    if (merk && merk.lon && merk.lat) ergebnis[i] = merk;
    else offen.push({ i: i, adresse: a, pfad: pfad });
  }

  for (let n = 0; n < offen.length; n++) {
    const o = offen[n];
    let punkt = null;
    try { punkt = await suchen(o.adresse); } catch (e) { /* nächste Adresse */ }
    if (punkt) {
      ergebnis[o.i] = punkt;
      if (ablage) { try { await ablage.setJSON(o.pfad, punkt); } catch (e) { /* egal */ } }
    }
    if (n < offen.length - 1) await warten(process.env.ORS_API_KEY ? 120 : 1100);
  }
  return ergebnis;
}

async function suchen(adresse) {
  const schluessel = process.env.ORS_API_KEY;

  if (schluessel) {
    const u = 'https://api.openrouteservice.org/geocode/search?api_key=' +
              encodeURIComponent(schluessel) + '&text=' + encodeURIComponent(adresse) +
              '&boundary.country=DE&size=1';
    const a = await fetch(u, { headers: { Accept: 'application/json' } });
    if (a.ok) {
      const d = await a.json();
      const f = (d.features || [])[0];
      if (f && f.geometry && f.geometry.coordinates) {
        return {
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          label: (f.properties && f.properties.label) || adresse
        };
      }
    }
  }

  // Ohne Schlüssel: offene Adresssuche von OpenStreetMap
  const u2 = 'https://nominatim.openstreetmap.org/search?format=json&limit=1' +
             '&countrycodes=de&q=' + encodeURIComponent(adresse);
  const b = await fetch(u2, {
    headers: { 'User-Agent': 'Baeckerei-Jung-Tourenplaner/1.0', Accept: 'application/json' }
  });
  if (!b.ok) return null;
  const liste = await b.json();
  const t = (liste || [])[0];
  if (!t) return null;
  return { lon: parseFloat(t.lon), lat: parseFloat(t.lat), label: t.display_name || adresse };
}

// ---------------------------------------------------- Fahrzeiten und Wege

async function gitterHolen(punkte) {
  const schluessel = process.env.ORS_API_KEY;

  if (schluessel && punkte.length <= 40) {
    try {
      const a = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
        method: 'POST',
        headers: {
          Authorization: schluessel,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          locations: punkte.map(function (p) { return [p.lon, p.lat]; }),
          metrics: ['duration', 'distance'],
          units: 'km'
        })
      });
      if (a.ok) {
        const d = await a.json();
        if (d.durations && d.distances) {
          return {
            quelle: 'ors',
            dauer: d.durations.map(function (z) {
              return z.map(function (s) { return s === null ? 9999 : s / 60; });
            }),
            weg: d.distances.map(function (z) {
              return z.map(function (s) { return s === null ? 999 : s; });
            })
          };
        }
      }
    } catch (e) { /* dann wird geschätzt */ }
  }

  // Schätzung: Luftlinie mit Zuschlag für den Straßenverlauf
  const dauer = [], weg = [];
  for (let i = 0; i < punkte.length; i++) {
    dauer.push([]); weg.push([]);
    for (let j = 0; j < punkte.length; j++) {
      if (i === j) { dauer[i].push(0); weg[i].push(0); continue; }
      const km = luftlinie(punkte[i], punkte[j]) * 1.3;
      weg[i].push(km);
      dauer[i].push(km / 48 * 60 + 1);
    }
  }
  return { quelle: 'schaetzung', dauer: dauer, weg: weg };
}

function luftlinie(a, b) {
  const r = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ---------------------------------------------------------- Kleinigkeiten

function saubere(wert) {
  return String(wert || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
function zahl(wert, ersatz) {
  const n = parseFloat(String(wert).replace(',', '.'));
  return isFinite(n) ? n : ersatz;
}
function begrenzt(n, min, max) { return Math.max(min, Math.min(max, n)); }
function runde(n, stellen) {
  const f = Math.pow(10, stellen);
  return Math.round(n * f) / f;
}
function minuten(wert) {
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(wert || '').trim());
  if (!t) return null;
  const h = parseInt(t[1], 10), m = parseInt(t[2], 10);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
function uhr(min) {
  let m = Math.round(min);
  const tage = Math.floor(m / 1440);
  m -= tage * 1440;
  const h = Math.floor(m / 60);
  return (h < 10 ? '0' : '') + h + ':' + ((m % 60) < 10 ? '0' : '') + (m % 60);
}
function warten(ms) { return new Promise(function (f) { setTimeout(f, ms); }); }

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
