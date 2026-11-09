import { structuredOutputFormat } from "../core/llm.js";
import { ExtractionSchema } from "../worker/extract.js";
import { NotesSchema } from "../worker/notes-extract.js";

/**
 * Prints the output formats of the chronicler's two calls exactly as they are sent (`output_config.format`), so they
 * can be tried against the API before a deploy: the API refuses a format whose compiled grammar is too large.
 *
 *   node dist/scripts/print-extraction-formats.js > formats.json
 */
console.log(JSON.stringify({ main: structuredOutputFormat(ExtractionSchema), notes: structuredOutputFormat(NotesSchema) }, null, 2));
