/** Shared, deterministic tools injected into every local audit rule. */

export function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function findDocuments(context, predicate) {
  return context.documents.filter((document, index) => predicate(document, index));
}

export function rankDocuments(
  context,
  { fileNameKeywords = [], textKeywords = [], kinds = [] } = {},
) {
  const normalizedFileKeywords = fileNameKeywords.map(normalizeSearchText).filter(Boolean);
  const normalizedTextKeywords = textKeywords.map(normalizeSearchText).filter(Boolean);
  return context.documents
    .map((document) => {
      const fileName = normalizeSearchText(document.local_name);
      const text = normalizeSearchText(document.full_text);
      const reasons = [];
      let score = 0;

      for (const keyword of normalizedFileKeywords) {
        if (fileName.includes(keyword)) {
          score += 3;
          reasons.push(`文件名包含“${keyword}”`);
        }
      }
      for (const keyword of normalizedTextKeywords) {
        if (text.includes(keyword)) {
          score += 2;
          reasons.push(`正文包含“${keyword}”`);
        }
      }
      if (kinds.includes(document.kind)) {
        score += 1;
        reasons.push(`文件类型为 ${document.kind}`);
      }
      return { document, score, reasons };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.document.document_id.localeCompare(right.document.document_id));
}

export function createAuditTools() {
  return Object.freeze({
    findDocuments,
    normalizeSearchText,
    rankDocuments,
  });
}
