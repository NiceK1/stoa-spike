// Prints the text rows the document pipeline extracts from a PDF page: npx tsx scripts/pdf-text.ts <file.pdf> [maxRows]
import { extractRows } from "../server/src/solvers/document.js";

const { rows, pageWidth, pageHeight, pages } = await extractRows(process.argv[2]);
console.log(`${pages} page(s); page 1 is ${pageWidth.toFixed(0)} x ${pageHeight.toFixed(0)} pt; ${rows.length} rows`);
for (const row of rows.slice(0, Number(process.argv[3] ?? 60))) console.log(`${row.id}\t${row.text}`);
