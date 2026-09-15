/**
 * Citation extractor for Indian legal documents.
 * Extracts IPC, CrPC, and IEA provisions with high precision.
 */

function extractCitations(text, referenceTable = null) {
  if (!text || typeof text !== 'string') return [];

  const found = new Map();
  const cleanText = text.replace(/\r\n/g, '\n');

  // Pattern A: Section-lead token followed within 40 chars by section numbers, associated with an Act name
  // Example: "under Sections 302, 307 and 341 IPC read with section 34 IPC"
  // Example: "Section 154 Cr.P.C."
  const sectionLeadRegex = /\b(?:sections?|sec\.?|u\/s|s\.)\s*([0-9]{1,4}[A-Za-z]?)(?:\s*(?:,|and|&)\s*([0-9]{1,4}[A-Za-z]?))*(?:\s*(?:,|and|&)\s*([0-9]{1,4}[A-Za-z]?))*(?:\s*(?:,|and|&)\s*([0-9]{1,4}[A-Za-z]?))*\s*(?:of\s+the\s+)?(IPC|Indian\s+Penal\s+Code|Cr\.?P\.?C\.?|Code\s+of\s+Criminal\s+Procedure|IEA|Evidence\s+Act|Indian\s+Evidence\s+Act)\b/gi;

  let m;
  while ((m = sectionLeadRegex.exec(cleanText)) !== null) {
    const fullMatch = m[0];
    const actRaw = m[m.length - 1];
    let act = 'IPC';
    if (/Cr\.?P\.?C|Criminal/i.test(actRaw)) act = 'CrPC';
    else if (/IEA|Evidence/i.test(actRaw)) act = 'IEA';
    else if (/IPC|Penal/i.test(actRaw)) act = 'IPC';

    const numRegex = /\b([0-9]{1,4}[A-Za-z]?)\b/g;
    let tm;
    while ((tm = numRegex.exec(fullMatch)) !== null) {
      const secStr = tm[1];
      const sectionNum = Number(tm[1]);
      if (isNaN(sectionNum)) continue;

      // Ensure reasonable section boundaries
      if (act === 'IPC' && sectionNum > 511) continue;
      if (act === 'CrPC' && sectionNum > 565) continue;
      if (act === 'IEA' && sectionNum > 167) continue;

      // 2.2 — Require section-lead token within 40 characters
      const leadMatch = fullMatch.match(/\b(?:sections?|sec\.?|u\/s|s\.)/i);
      const leadIndex = leadMatch ? leadMatch.index : 0;
      if (Math.abs(tm.index - leadIndex) > 40) continue;

      const citation = `${act} ${secStr.toUpperCase()}`;

      // 2.1 — Reject any section number less than 20 unless it appears in reference table's old field
      if (sectionNum < 20 && referenceTable) {
        const known = referenceTable.some(
          (e) => String(e.old).toUpperCase().replace(/\s+/g, ' ') === citation.toUpperCase()
        );
        if (!known) continue; // skip low-number false positive
      }

      found.set(citation, { citation, section: secStr.toUpperCase(), act });
    }
  }

  // Pattern B: Act name preceding the section number
  // Example: "under IPC 420", "IPC 302", "CrPC 482"
  const actFirstRegex = /\b(IPC|Cr\.?P\.?C\.?|IEA)\s*(?:section|sec\.?|s\.)?\s*([0-9]{1,4}[A-Za-z]?)\b/gi;
  while ((m = actFirstRegex.exec(cleanText)) !== null) {
    const actRaw = m[1];
    let act = 'IPC';
    if (/Cr\.?P\.?C/i.test(actRaw)) act = 'CrPC';
    else if (/IEA/i.test(actRaw)) act = 'IEA';
    else if (/IPC/i.test(actRaw)) act = 'IPC';

    const secStr = m[2];
    const sectionNum = Number(secStr);
    if (isNaN(sectionNum)) continue;

    if (act === 'IPC' && sectionNum > 511) continue;
    if (act === 'CrPC' && sectionNum > 565) continue;
    if (act === 'IEA' && sectionNum > 167) continue;

    const citation = `${act} ${secStr.toUpperCase()}`;

    // 2.1 — Reject any section number less than 20 unless it appears in reference table's old field
    if (sectionNum < 20 && referenceTable) {
      const known = referenceTable.some(
        (e) => String(e.old).toUpperCase().replace(/\s+/g, ' ') === citation.toUpperCase()
      );
      if (!known) continue; // skip low-number false positive
    }

    found.set(citation, { citation, section: secStr.toUpperCase(), act });
  }

  return Array.from(found.values());
}

module.exports = { extractCitations };
