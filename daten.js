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

  // Einladung per E-Mail verschicken (über Resend)
  if (eingabe.aktion === 'einladung-senden') {
    const schluessel = process.env.RESEND_API_KEY;
    if (!schluessel) {
      return antwort(500, { fehler: 'Es ist kein Maildienst hinterlegt (RESEND_API_KEY fehlt).' });
    }
    const chefwort = process.env.CHEF_PASSWORT;
    if (chefwort && !gleich(String(eingabe.passwort || ''), chefwort)) {
      return antwort(401, { fehler: 'Das Passwort stimmt nicht.' });
    }

    const email = String(eingabe.email || '').trim();
    const name = String(eingabe.name || '').trim();
    const link = String(eingabe.link || '').trim();
    if (!email || !link) {
      return antwort(400, { fehler: 'E-Mail und Link werden benötigt.' });
    }

    const von = process.env.RESEND_VON || 'Bäckerei Jung <onboarding@resend.dev>';
    const text =
      'Guten Tag,\n\nfür ' + name + ' steht ab sofort die Bestellseite der Bäckerei Jung bereit.\n\n' +
      'Über diesen Link vergeben Sie Ihr eigenes Passwort:\n' + link + '\n\n' +
      'Der Link ist zwei Wochen gültig.\n\nFreundliche Grüße\nBäckerei Jung';

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#17162B;line-height:1.6">' +
      '<div style="background:#2E2A79;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">' +
      '<b style="font-size:18px">Bäcker <span style="color:#FFC800">Jung</span></b></div>' +
      '<div style="border:1px solid #DDDAE8;border-top:none;padding:20px;border-radius:0 0 10px 10px">' +
      '<p>Guten Tag,</p><p>für <b>' + entschaerft(name) + '</b> steht ab sofort die Bestellseite ' +
      'der Bäckerei Jung bereit. Über den folgenden Link vergeben Sie Ihr eigenes Passwort:</p>' +
      '<p style="margin:22px 0"><a href="' + entschaerft(link) + '" ' +
      'style="background:#2E2A79;color:#fff;text-decoration:none;padding:13px 22px;' +
      'border-radius:9px;font-weight:bold;display:inline-block">Passwort vergeben</a></p>' +
      '<p style="font-size:13px;color:#6B6880">Falls der Knopf nicht funktioniert:<br>' +
      '<a href="' + entschaerft(link) + '">' + entschaerft(link) + '</a></p>' +
      '<p style="font-size:13px;color:#6B6880">Der Link ist zwei Wochen gültig.</p>' +
      '<p>Freundliche Grüße<br>Bäckerei Jung</p></div></div>';

    try {
      const a = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + schluessel, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: von, to: [email],
          subject: 'Ihr Zugang zur Bestellseite der Bäckerei Jung',
          text: text, html: html
        })
      });
      const ergebnis = await a.json().catch(function () { return {}; });
      if (!a.ok) {
        return antwort(502, {
          fehler: (ergebnis && (ergebnis.message || ergebnis.error)) || ('Der Maildienst antwortet mit ' + a.status)
        });
      }
      return antwort(200, { gesendet: true, an: email, id: ergebnis.id || '' });
    } catch (fehler) {
      return antwort(502, { fehler: 'Die E-Mail konnte nicht versendet werden: ' + fehler.message });
    }
  }

  // Einladung prüfen: gehört der Link zu einem Kunden und ist er noch gültig?
  if (eingabe.aktion === 'einladung-pruefen' || eingabe.aktion === 'einladung-einloesen') {
    const marke = String(eingabe.marke || '');
    if (!marke) return antwort(400, { fehler: 'Der Einladungslink ist unvollständig.' });

    try {
      const ablage = getStore('chefdaten');
      const daten = (await ablage.get('kunden/alle', { type: 'json' })) || { kunden: [] };
      const liste = daten.kunden || [];
      const kunde = liste.filter(function (k) { return k.marke && k.marke === marke; })[0];

      if (!kunde) {
        return antwort(404, { fehler: 'Dieser Einladungslink ist nicht mehr gültig.' });
      }
      if (kunde.markeBis && new Date(kunde.markeBis) < new Date()) {
        return antwort(410, { fehler: 'Der Einladungslink ist abgelaufen. Bitte eine neue Einladung anfordern.' });
      }

      if (eingabe.aktion === 'einladung-pruefen') {
        return antwort(200, { name: kunde.name || '', email: kunde.email || '' });
      }

      const passwort = String(eingabe.passwort || '');
      if (passwort.length < 8) {
        return antwort(400, { fehler: 'Das Passwort muss mindestens acht Zeichen haben.' });
      }
      kunde.passwort = passwort;
      kunde.aktiv = true;
      delete kunde.marke;
      delete kunde.markeBis;
      kunde.freigeschaltet = new Date().toISOString();
      await ablage.setJSON('kunden/alle', { kunden: liste });
      return antwort(200, { fertig: true, name: kunde.name || '' });
    } catch (fehler) {
      return antwort(502, { fehler: 'Das hat gerade nicht geklappt: ' + fehler.message });
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
      if (treffer && !treffer.passwort) {
        return antwort(403, { fehler: 'Für diesen Zugang wurde noch kein Passwort vergeben. ' +
                                      'Bitte den Einladungslink aus der E-Mail benutzen.' });
      }
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

// Spitze Klammern in Texten unschädlich machen
function entschaerft(wert) {
  return String(wert || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
