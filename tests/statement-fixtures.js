// Entirely synthetic statements. Minimal PDF writer avoids a test-only PDF dependency.
export const csv = 'Date,Description,Debit,Credit,Balance\r\n01/09/2026,"Cafe, Central",125.50,,9874.50\r\n02/09/2026,Salary,,50000.00,59874.50\r\n';
export function pdfFixture({ empty = false, pages = 1 } = {}) {
  const objects = [], add = text => { objects.push(text); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let page = 0; page < pages; page++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`);
    let stream = '';
    const line = (y, cells) => cells.forEach(([x, text]) => { stream += `BT /F1 9 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET\n`; });
    if (!empty) {
      line(720, [[40, 'Date'], [140, 'Description'], [330, 'Debit'], [410, 'Credit'], [510, 'Balance']]);
      line(700, [[40, '01/09/2026'], [140, 'Cafe'], [330, '125.50'], [510, '9874.50']]);
      line(688, [[140, 'Central']]);
      line(670, [[40, '02/09/2026'], [140, 'Salary'], [410, '50000.00'], [510, '59874.50']]);
    }
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let result = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
