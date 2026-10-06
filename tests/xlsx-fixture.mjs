// Builds small .xlsx files for tests: deflate-compressed zip parts and shared strings, as Excel writes them.
import { deflateRawSync } from 'node:zlib';

const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const crc32 = (buf) => {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
};
/** Minimal deflate-compressed zip, as Excel writes it. */
function zipDeflate(files) {
  const chunks = [];
  const central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(raw);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    chunks.push(lh, nm, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  const all = Buffer.concat([...chunks, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}
/** rows: array of arrays of numbers / strings (shared strings); returns sheet xml + shared strings. */
function sheetXml(rows, shared) {
  const colName = (i) => String.fromCharCode(65 + i);
  const out = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    if (typeof v === 'number') return `<c r="${colName(ci)}${ri + 1}"><v>${v}</v></c>`;
    let ix = shared.indexOf(v);
    if (ix < 0) ix = shared.push(v) - 1;
    return `<c r="${colName(ci)}${ri + 1}" t="s"><v>${ix}</v></c>`;
  }).join('')}</row>`);
  return `<?xml version="1.0"?><worksheet><sheetData>${out.join('')}</sheetData></worksheet>`;
}
export function workbook(sheets) {
  const shared = [];
  const files = {};
  const wbSheets = [];
  const rels = [];
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, shared);
    wbSheets.push(`<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`);
    rels.push(`<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`);
  });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns:r="r"><sheets>${wbSheets.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<Relationships>${rels.join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<sst>${shared.map((t) => `<si><t>${xmlEsc(t)}</t></si>`).join('')}</sst>`;
  return zipDeflate(files);
}
export const excelSerial = (y, mo, d, h, mi) => (Date.UTC(y, mo - 1, d, h, mi) / 86400000) + 25569;

