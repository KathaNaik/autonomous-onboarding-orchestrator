/**
 * (M11) Minimal, dependency-free PDF writer for synthetic offer letters (tests and the eval):
 * one or more Letter-size pages of Helvetica text lines. Not a general PDF library.
 */
export function syntheticPdf(lines: readonly string[], linesPerPage = 46): Uint8Array {
  const esc = (s: string) =>
    s
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage) as string[]);
  }
  const objects: string[] = [];
  const add = (body: string) => (objects.push(body), objects.length);
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const text = [
      "BT",
      "/F1 11 Tf",
      "14 TL",
      "72 740 Td",
      ...pageLines.map((l, i) => `${i === 0 ? "" : "T* "}(${esc(l)}) Tj`),
      "ET",
    ].join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** A synthetic offer letter in a common layout (all people and companies are fictional). */
export function syntheticOfferLetter(fields: {
  candidate: string;
  email?: string;
  title: string;
  department: string;
  manager?: string;
  startDate?: string;
  extraLines?: readonly string[];
}): Uint8Array {
  return syntheticPdf([
    "Example Corp (fictional)",
    "",
    "OFFER OF EMPLOYMENT",
    "",
    `Dear ${fields.candidate},`,
    "",
    `We are pleased to offer you the position of ${fields.title} in our ${fields.department} department.`,
    ...(fields.manager ? [`You will report to ${fields.manager}.`] : []),
    ...(fields.startDate ? [`Your start date will be ${fields.startDate}.`] : []),
    ...(fields.email ? [`Your company email address will be ${fields.email}.`] : []),
    ...(fields.extraLines ?? []),
    "",
    "Please sign below to accept this offer.",
    "",
    "Sincerely,",
    "Pat Example, Head of People",
  ]);
}
