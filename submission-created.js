// netlify/functions/submission-created.js
//
// Läuft automatisch bei jeder abgeschickten Bestellung.
// Legt sie dauerhaft in Netlify Blobs ab, damit die Chef-Ansicht sie auch
// nach Jahren noch findet – unabhängig davon, wie viele Eingänge das
// Formularpostfach vorhält. Es ist kein API-Token nötig.

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

exports.handler = async function (event) {
  let nachricht = {};
  try { nachricht = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 200 }; }

  const eingang = nachricht.payload || nachricht;
  const d = eingang.data || {};
  const formular = (eingang.form_name || 'bestellung').toLowerCase();
  const istRetoure = formular.indexOf('retoure') > -1;

  const bestellung = {
    id:         eingang.id || String(Date.now()),
    erstellt:   eingang.created_at || new Date().toISOString(),
    filiale:    d.filiale    || '',
    datum:      d.datum      || '',
    besteller:  d.besteller  || '',
    positionen: d.positionen || '0',
    stueck:     d.stueck     || '0',
    warenwert:  d.warenwert  || d.retourenwert || '',
    quote:      d.quote      || '',
    art:        istRetoure ? 'retoure' : 'bestellung',
    bemerkung:  d.bemerkung  || '',
    uebersicht: d.uebersicht || '',
    csv:        dateiUrl(d.csv),
    pdf:        dateiUrl(d.pdf)
  };

  try {
    const ablage = getStore(istRetoure ? 'retouren' : 'bestellungen');
    // Schlüssel nach Datum sortierbar: Bestelldatum, Filiale, Eingangs-ID
    const tag = istDatum(bestellung.datum) ? umgedreht(bestellung.datum) : bestellung.erstellt.slice(0, 10);
    await ablage.setJSON(tag + '/' + sauber(bestellung.filiale) + '-' + bestellung.id, bestellung);
  } catch (fehler) {
    console.error('Bestellung konnte nicht abgelegt werden:', fehler.message);
  }

  return { statusCode: 200, body: 'ok' };
};

function dateiUrl(wert) {
  if (!wert) return '';
  if (typeof wert === 'string') return wert;
  return wert.url || '';
}
function istDatum(wert) { return /^\d{2}\.\d{2}\.\d{4}$/.test(wert); }
function umgedreht(wert) { const t = wert.split('.'); return t[2] + '-' + t[1] + '-' + t[0]; }
function sauber(wert) { return String(wert).replace(/[^\w]+/g, '_').slice(0, 40) || 'ohne'; }
