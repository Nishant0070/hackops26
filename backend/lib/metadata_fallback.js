/**
 * Deterministic Legal Metadata & Summary Fallback Extractor
 * 
 * Provides rule-based extraction for Indian legal documents when LLM/Groq fails,
 * times out, rate-limits, or returns invalid JSON.
 * 
 * Grounded strictly in extracted document text: no hallucination, no guessing.
 */

/**
 * Normalizes text lines and whitespace for reliable matching.
 */
function cleanHeader(text) {
    if (!text || typeof text !== 'string') return '';
    return text.substring(0, 8000).replace(/\r\n/g, '\n');
}

/**
 * Extracts case number from document text.
 * Handles formats like:
 * - Criminal Appeal No. 2114 of 2009
 * - Civil Appeal No. 123 of 2020
 * - Writ Petition No. 3468 of 2024 / W.P. No. ...
 * - Special Leave Petition (C) No. 456 of 2021 / SLP ...
 * - First Appeal No. 1370 of 2017 / FA No. ...
 * - Public Interest Litigation No. 30 of 2024 / PIL No. ...
 */
function extractCaseNumberFallback(text) {
    const header = cleanHeader(text);
    if (!header) return null;

    const patterns = [
        // Criminal / Civil Appeal
        /\b((?:Criminal|Civil)\s+Appeal\s+No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i,
        // First Appeal / FA
        /\b((?:First\s+Appeal|FA)\s+No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i,
        // Public Interest Litigation / PIL
        /\b((?:Public\s+Interest\s+Litigation|PIL)\s*(?:\(C\)|\(Crl\))?\s*No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i,
        // Writ Petition / W.P.
        /\b((?:Writ\s+Petition|W\.?\s*P\.?)\s*(?:\(C\)|\(Crl\)|\(Civil\))?\s*No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i,
        // Special Leave Petition / SLP
        /\b((?:Special\s+Leave\s+Petition|SLP)\s*(?:\(C\)|\(Crl\))?\s*No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i,
        // General Appeal / Petition / Application / Case No.
        /\b((?:Criminal|Civil|Misc(?:ellaneous)?)\s+(?:Petition|Application)\s+No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i,
        /\b((?:Appeal|Petition|Application|Case)\s+No\.?\s*([0-9\/\-]+\s*(?:of\s+[0-9]{4})?))/i
    ];

    for (const pat of patterns) {
        const match = header.match(pat);
        if (match && match[1]) {
            let res = match[1].replace(/\s+/g, ' ').trim();
            // Ensure proper dot after No if missing
            res = res.replace(/\bNo\.?\s+/i, 'No. ');
            // Normalize prefix casing (e.g. CRIMINAL APPEAL -> Criminal Appeal)
            res = res.replace(/^([A-Za-z\s]+?)\s+(No\.\s+.*)$/i, (m, prefix, rest) => {
                const formattedPrefix = prefix.split(' ').map(w => {
                    if (w.toUpperCase() === 'FA') return 'FA';
                    if (w.toUpperCase() === 'SLP') return 'SLP';
                    if (w.toUpperCase() === 'PIL') return 'PIL';
                    if (w.toUpperCase() === 'WP') return 'WP';
                    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
                }).join(' ');
                // Standardize "of" in lower case
                const formattedRest = rest.replace(/\bOF\b/i, 'of');
                return `${formattedPrefix} ${formattedRest}`;
            });
            return res;
        }
    }

    return null;
}

/**
 * Extracts court name from explicit textual evidence.
 */
function extractCourtNameFallback(text) {
    const header = cleanHeader(text);
    if (!header) return null;

    // Supreme Court of India
    if (/SUPREME\s+COURT\s+OF\s+INDIA/i.test(header)) {
        return "Supreme Court of India";
    }

    // High Court of Judicature at ... or High Court of ...
    const hcMatch = header.match(/(?:IN\s+THE\s+)?HIGH\s+COURT\s+OF\s+JUDICATURE\s+(?:AT|FOR)\s+([A-Z\s]+?)(?:\n|\r|CIVIL|CRIMINAL|APPELLATE|BENCH|\.|$)/i)
                 || header.match(/(?:IN\s+THE\s+)?HIGH\s+COURT\s+OF\s+([A-Z\s]+?)(?:\n|\r|CIVIL|CRIMINAL|APPELLATE|BENCH|\.|$)/i);
    
    if (hcMatch && hcMatch[1]) {
        let city = hcMatch[1].replace(/\s+/g, ' ').trim();
        // Capitalize nicely, e.g. BOMBAY -> Bombay
        city = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (city.length > 2 && city.length < 30) {
            return `High Court of Judicature at ${city}`;
        }
    }

    // District Court
    const dcMatch = header.match(/(?:IN\s+THE\s+COURT\s+OF\s+[^\n,]+,\s*)?(DISTRICT\s+(?:AND\s+SESSIONS\s+)?COURT[A-Z\s,]*?)(?:\n|\r|\.|$)/i)
                 || header.match(/(COURT\s+OF\s+DISTRICT\s+[A-Z\s,]+?)(?:\n|\r|\.|$)/i);
    if (dcMatch && dcMatch[1]) {
        let court = dcMatch[1].replace(/\s+/g, ' ').trim();
        if (court.length > 5 && court.length < 60) {
            return court.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        }
    }

    return null;
}

/**
 * Extracts document type from explicit textual evidence near document header.
 */
function extractDocTypeFallback(text) {
    const header = cleanHeader(text);
    if (!header) return null;

    // Prioritized check from header context
    if (/\b(?:WRIT\s+PETITION)\b/i.test(header)) return "Writ Petition";
    if (/\b(?:BAIL\s+APPLICATION)\b/i.test(header)) return "Bail Application";
    if (/\b(?:AFFIDAVIT)\b/i.test(header)) return "Affidavit";
    if (/\b(?:JUDGMENT|JUDGEMENT)\b/i.test(header)) return "Judgment";
    if (/\b(?:ORDER|ORDER\s+SHEET)\b/i.test(header)) return "Order";
    if (/\b(?:APPEAL)\b/i.test(header)) return "Appeal";
    if (/\b(?:PETITION)\b/i.test(header)) return "Petition";

    return null;
}

/**
 * Extracts parties from explicit case heading patterns.
 * Supports:
 * - RAMPAL SINGH v. STATE OF UP
 * - [Party 1] ...Petitioner/Appellant Vs. [Party 2] ...Respondent
 */
function extractPartiesFallback(text) {
    const header = cleanHeader(text);
    if (!header) return [];

    const parties = [];

    // Pattern A: Standard Indian Court format with roles
    // Example: "Bhausaheb Bhujangrao Pawar ...Petitioner\nVis.\nThe State of Maharashtra ...Respondent"
    // Example: "1) Smt. Sangeeta Dinesh Dhokle ...Appellants\nVersus\nUnion of India ...Respondent"
    // Example with brackets: "1) Smt. Sangeeta...\n] ...Appellants\nVersus\nUnion of India\n] ...Respondent"
    const patternA = /(?:^|\n)[ \t]*(?:[0-9]+\))?[ \t]*([^\n\r]+?)[ \t]*(?:\n|\r|\s)*[\]\)]*[ \t]*(?:\.\.\.|\s)[ \t]*(Petitioner|Appellant|Applicant|Plaintiff|Complainant)s?[ \t]*(?:\n|\r|\s)+(?:Versus|Vs\.?|Vis\.?|V\.)[ \t]*(?:\n|\r|\s)+(?:[0-9]+\))?[ \t]*([^\n\r]+(?:\n[^\n\r]+){0,2}?)[ \t]*(?:\n|\r|\s)*[\]\)]*[ \t]*(?:\.\.\.|\s)[ \t]*(Respondent|Defendant|Opposite\s+Party|Accused)s?/i;
    
    const matchA = header.match(patternA);
    if (matchA) {
        let rawP1 = matchA[1];
        let rawP2 = matchA[3];
        // If multiline slipped in for P1, grab the last line
        if (rawP1.includes('\n')) rawP1 = rawP1.split('\n').pop();

        const p1Name = cleanPartyName(rawP1);
        const p1Role = normalizePartyRole(matchA[2]);
        const p2Name = cleanPartyName(rawP2);
        const p2Role = normalizePartyRole(matchA[4]);

        if (p1Name && p2Name && isValidPartyName(p1Name) && isValidPartyName(p2Name)) {
            parties.push({ name: p1Name, role: p1Role });
            parties.push({ name: p2Name, role: p2Role });
            return parties;
        }
    }

    // Pattern B: Simple V. or VERSUS header block
    // Example: "RAMPAL SINGH v. STATE OF UP"
    // Example: "RAMPAL SINGH\nv.\nSTATE OF U.P."
    const patternB = /(?:^|\n)[ \t]*([A-Z][A-Za-z\s.,'–-]{2,50}[A-Za-z])[ \t]*(?:\n|\r|\s)+(?:Versus|Vs\.?|V\.)[ \t]*(?:\n|\r|\s)+([A-Z][A-Za-z\s.,'–-]{2,50}[A-Za-z])(?=\r|\n|$)/i;
    const matchB = header.match(patternB);
    if (matchB) {
        let p1Name = cleanPartyName(matchB[1]);
        let p2Name = cleanPartyName(matchB[2]);

        // Strip any trailing month or year if captured on the same line
        p2Name = p2Name.replace(/\b(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b.*$/i, '').trim();

        // Filter out non-party noise lines (e.g. "CIVIL APPELLATE JURISDICTION", "IN THE SUPREME COURT")
        if (isValidPartyName(p1Name) && isValidPartyName(p2Name)) {
            parties.push({ name: p1Name, role: "Petitioner/Appellant" });
            parties.push({ name: p2Name, role: "Respondent" });
            return parties;
        }
    }

    return parties;
}

function cleanPartyName(str) {
    if (!str) return '';
    let name = str.replace(/\s+/g, ' ').replace(/^\d+[\s\).–-]+/, '').trim();
    // Trim trailing ellipses or punctuation
    name = name.replace(/[\s\.\,\–\-]+$/, '').trim();
    return name;
}

function normalizePartyRole(role) {
    if (!role) return 'Party';
    const r = role.toLowerCase();
    if (r.includes('appellant')) return 'Appellant';
    if (r.includes('petitioner')) return 'Petitioner';
    if (r.includes('plaintiff')) return 'Plaintiff';
    if (r.includes('complainant')) return 'Complainant';
    if (r.includes('applicant')) return 'Applicant';
    if (r.includes('respondent')) return 'Respondent';
    if (r.includes('defendant')) return 'Defendant';
    if (r.includes('accused')) return 'Accused';
    return role.trim();
}

function isValidPartyName(name) {
    if (!name || name.length < 3 || name.length > 150) return false;
    const upper = name.toUpperCase();
    if (upper.includes('HIGH COURT') || upper.includes('SUPREME COURT') || upper.includes('JURISDICTION') ||
        upper.includes('APPELLATE') || upper.includes('ADVOCATE') || upper.includes('JUDGMENT') ||
        upper.includes('ORDER') || upper.includes('SECTION') || upper.includes('DATE')) {
        return false;
    }
    return true;
}

/**
 * Extracts explicit legal-document dates from the text.
 * Strictly avoids page numbers, section numbers, case numbers, and isolated statute years.
 */
function extractKeyDatesFallback(text) {
    if (!text || typeof text !== 'string') return [];
    const dates = [];
    const seenDates = new Set();

    // Look primarily at the header (first 5000 chars) and footer (last 3000 chars)
    const headerText = text.substring(0, 5000);
    const footerText = text.length > 5000 ? text.substring(text.length - 3000) : '';
    const searchScope = headerText + '\n--- FOOTER ---\n' + footerText;

    // Pattern 1: Dates with contextual event prefix
    // e.g., "Dated: 2nd September, 2026", "Pronounced on: 25th February, 2025", "Reserved on: 16th January, 2025", "Uploaded on - 03/09/2026"
    const contextDateRegex = /(?:(Dated|Pronounced\s+on|Reserved\s+on|Hearing\s+on|Order\s+dated|Decided\s+on|Uploaded\s+on|Date\s+of\s+Order|Date\s+of\s+incident)[:\s\-]+)((?:[0-9]{1,2}(?:st|nd|rd|th|\*)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+[0-9]{4})|(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+[0-9]{1,2},?\s+[0-9]{4})|(?:[0-9]{1,2}[\/\.-][0-9]{1,2}[\/\.-][0-9]{4}))/gi;

    let m;
    while ((m = contextDateRegex.exec(searchScope)) !== null) {
        const rawEvent = m[1].replace(/[:\s\-]+$/, '').trim();
        let rawDate = m[2].replace(/\*/g, '').trim();
        const normKey = rawDate.toLowerCase().replace(/[^a-z0-9]/g, '');

        if (!seenDates.has(normKey)) {
            seenDates.add(normKey);
            let event = "Document Date";
            const evLow = rawEvent.toLowerCase();
            if (evLow.includes('pronounced') || evLow.includes('decided')) event = "Date pronounced";
            else if (evLow.includes('reserved')) event = "Date reserved";
            else if (evLow.includes('incident')) event = "Date of incident";
            else if (evLow.includes('hearing')) event = "Hearing date";
            else if (evLow.includes('order')) event = "Date of Order";
            else if (evLow.includes('uploaded')) event = "Date uploaded";

            dates.push({ date: rawDate, event });
        }
    }

    // Pattern 2: Standalone explicit legal dates in header
    // e.g. "JULY 24, 2012" or "25th February, 2025" or "DATED: 2* SEPTEMBER, 2026"
    const explicitDateRegex = /\b((?:[0-9]{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+[12][0-9]{3})|(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+[0-9]{1,2},?\s+[12][0-9]{3}))\b/gi;

    while ((m = explicitDateRegex.exec(headerText)) !== null) {
        const rawDate = m[1].trim();
        const normKey = rawDate.toLowerCase().replace(/[^a-z0-9]/g, '');

        if (!seenDates.has(normKey)) {
            seenDates.add(normKey);
            dates.push({ date: rawDate, event: "Judgment/Order Date" });
        }
    }

    // Cap at 4 distinct meaningful dates to prevent clutter
    return dates.slice(0, 4);
}

/**
 * Builds an evidence-based fallback summary when Groq fails.
 * STRICT REQUIREMENT:
 * - Do NOT invent facts, legal conclusions, outcomes, parties, dates, or procedural history.
 * - Rely only on explicitly verified document metadata, extracted citations, and heading.
 */
function buildFallbackSummary(metadata, citations = []) {
    const { doc_type, case_number, court_name, parties, key_dates } = metadata;

    const enBullets = [];
    const hiBullets = [];

    // Bullet 1: Identification of case and court
    let idEn = `${doc_type || 'Legal document'}`;
    let idHi = `${doc_type === 'Judgment' ? 'निर्णय' : (doc_type === 'Order' ? 'आदेश' : 'कानूनी दस्तावेज')}`;

    if (case_number && case_number !== 'N/A') {
        idEn += ` (${case_number})`;
        idHi += ` (${case_number})`;
    }
    if (court_name && court_name !== 'Unknown Court') {
        idEn += ` before the ${court_name}.`;
        idHi += `, ${court_name} के समक्ष प्रस्तुत।`;
    } else {
        idEn += `.`;
        idHi += `।`;
    }
    enBullets.push(idEn);
    hiBullets.push(idHi);

    // Bullet 2: Parties involved
    if (parties && parties.length >= 2) {
        const p1 = parties[0];
        const p2 = parties[1];
        enBullets.push(`Parties to the proceeding: ${p1.name} (${p1.role || 'Petitioner/Appellant'}) and ${p2.name} (${p2.role || 'Respondent'}).`);
        hiBullets.push(`कार्यवाही के पक्षकार: ${p1.name} (${p1.role || 'याचिकाकर्ता/अपीलकर्ता'}) एवं ${p2.name} (${p2.role || 'प्रतिवादी'})।`);
    } else if (parties && parties.length === 1) {
        enBullets.push(`Party mentioned in the document: ${parties[0].name} (${parties[0].role || 'Party'}).`);
        hiBullets.push(`दस्तावेज में उल्लेखित पक्षकार: ${parties[0].name} (${parties[0].role || 'पक्षकार'})।`);
    }

    // Bullet 3: Key dates
    if (key_dates && key_dates.length > 0) {
        const dateDescs = key_dates.map(d => `${d.event}: ${d.date}`).join('; ');
        enBullets.push(`Key dates recorded in the document: ${dateDescs}.`);
        hiBullets.push(`दस्तावेज में दर्ज प्रमुख तिथियां: ${dateDescs}।`);
    }

    // Bullet 4: Citations / Legal Provisions
    if (citations && citations.length > 0) {
        const citList = citations.map(c => c.citation || `${c.act} ${c.section}`).filter(Boolean).slice(0, 6).join(', ');
        if (citList) {
            enBullets.push(`Cites legal provisions under: ${citList}.`);
            hiBullets.push(`संदर्भित कानूनी धाराएं: ${citList}।`);
        }
    }

    // Safe fallback if document has minimal extractable metadata
    if (enBullets.length === 1 && !case_number && !court_name && (!parties || parties.length === 0)) {
        enBullets.push("Document text was extracted successfully, but an automated summary could not be generated.");
        hiBullets.push("दस्तावेज़ का पाठ सफलतापूर्वक निकाला गया, किंतु स्वचालित सारांश तैयार नहीं किया जा सका।");
    }

    return {
        summary_en: enBullets,
        summary_hi: hiBullets
    };
}

/**
 * Main Deterministic Fallback Function.
 * Runs AFTER Groq results are obtained.
 * Applies fallback ONLY when a corresponding field is missing, empty, null, or unusable.
 * NEVER overwrites valid Groq data.
 */
function applyDeterministicFallbacks(rawText, structData = {}, explainData = {}, citations = []) {
    const enrichedStruct = { ...structData };
    const enrichedExplain = { ...explainData };

    // 1. Case Number
    const isCaseNumMissing = !enrichedStruct.case_number || 
                             enrichedStruct.case_number === 'N/A' || 
                             enrichedStruct.case_number === 'null' ||
                             typeof enrichedStruct.case_number !== 'string' ||
                             enrichedStruct.case_number.trim() === '';
    if (isCaseNumMissing) {
        const fallbackCaseNo = extractCaseNumberFallback(rawText);
        if (fallbackCaseNo) {
            console.log(`[Fallback] Recovered case_number: "${fallbackCaseNo}"`);
            enrichedStruct.case_number = fallbackCaseNo;
        }
    }

    // 2. Court Name
    const isCourtMissing = !enrichedStruct.court_name || 
                           enrichedStruct.court_name === 'Unknown Court' || 
                           enrichedStruct.court_name === 'N/A' ||
                           typeof enrichedStruct.court_name !== 'string' ||
                           enrichedStruct.court_name.trim() === '';
    if (isCourtMissing) {
        const fallbackCourt = extractCourtNameFallback(rawText);
        if (fallbackCourt) {
            console.log(`[Fallback] Recovered court_name: "${fallbackCourt}"`);
            enrichedStruct.court_name = fallbackCourt;
        }
    }

    // 3. Document Type
    const isDocTypeMissing = !enrichedStruct.doc_type || 
                             enrichedStruct.doc_type === 'Legal Document' || 
                             enrichedStruct.doc_type === 'N/A' ||
                             typeof enrichedStruct.doc_type !== 'string' ||
                             enrichedStruct.doc_type.trim() === '';
    if (isDocTypeMissing) {
        const fallbackDocType = extractDocTypeFallback(rawText);
        if (fallbackDocType) {
            console.log(`[Fallback] Recovered doc_type: "${fallbackDocType}"`);
            enrichedStruct.doc_type = fallbackDocType;
        }
    }

    // 4. Parties
    const arePartiesMissing = !enrichedStruct.parties || 
                              !Array.isArray(enrichedStruct.parties) || 
                              enrichedStruct.parties.length === 0;
    if (arePartiesMissing) {
        const fallbackParties = extractPartiesFallback(rawText);
        if (fallbackParties && fallbackParties.length > 0) {
            console.log(`[Fallback] Recovered ${fallbackParties.length} parties:`, fallbackParties.map(p => p.name));
            enrichedStruct.parties = fallbackParties;
        }
    }

    // 5. Key Dates
    const areDatesMissing = !enrichedStruct.key_dates || 
                            !Array.isArray(enrichedStruct.key_dates) || 
                            enrichedStruct.key_dates.length === 0;
    if (areDatesMissing) {
        const fallbackDates = extractKeyDatesFallback(rawText);
        if (fallbackDates && fallbackDates.length > 0) {
            console.log(`[Fallback] Recovered ${fallbackDates.length} key_dates:`, fallbackDates);
            enrichedStruct.key_dates = fallbackDates;
        }
    }

    // 6. Summary (English & Hindi)
    const isSummaryMissing = !enrichedExplain.summary_en || 
                             !Array.isArray(enrichedExplain.summary_en) || 
                             enrichedExplain.summary_en.length === 0;
    if (isSummaryMissing) {
        const fallbackSummary = buildFallbackSummary(enrichedStruct, citations);
        console.log(`[Fallback] Generated evidence-based fallback summary (${fallbackSummary.summary_en.length} bullets)`);
        enrichedExplain.summary_en = fallbackSummary.summary_en;
        if (!enrichedExplain.summary_hi || !Array.isArray(enrichedExplain.summary_hi) || enrichedExplain.summary_hi.length === 0) {
            enrichedExplain.summary_hi = fallbackSummary.summary_hi;
        }
    }

    return {
        structData: enrichedStruct,
        explainData: enrichedExplain
    };
}

module.exports = {
    extractCaseNumberFallback,
    extractCourtNameFallback,
    extractDocTypeFallback,
    extractPartiesFallback,
    extractKeyDatesFallback,
    buildFallbackSummary,
    applyDeterministicFallbacks
};
