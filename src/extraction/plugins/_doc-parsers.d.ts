/**
 * Ambient module declarations for the two binary-document parsers the Drive
 * extraction plugin uses to convert uploaded PDF / DOCX files into agent-
 * readable markdown. Neither ships first-class TypeScript types we can rely on
 * across the rollup build, so we declare the minimal surface we actually call.
 * Both are real runtime dependencies (see package.json) and are marked external
 * in rollup.config.js, so the bundler never tries to inline them.
 *
 * `pdf-parse` is imported via its inner `lib/pdf-parse.js` path on purpose: the
 * package's `index.js` runs a debug block when `module.parent` is falsy (true
 * under ESM/bundlers), which reads a bundled sample PDF off disk and throws at
 * import time. The inner module skips that block.
 */

declare module 'pdf-parse/lib/pdf-parse.js' {
    interface PdfParseResult {
        text: string;
        numpages: number;
        numrender: number;
        info: unknown;
        metadata: unknown;
        version: string;
    }
    export default function pdfParse(data: Buffer | Uint8Array | ArrayBuffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
}

declare module 'mammoth' {
    interface MammothMessage {
        type: string;
        message: string;
    }
    interface MammothResult {
        value: string;
        messages: MammothMessage[];
    }
    interface MammothBufferInput {
        buffer: Buffer;
    }
    export function convertToMarkdown(input: MammothBufferInput): Promise<MammothResult>;
    export function convertToHtml(input: MammothBufferInput): Promise<MammothResult>;
    export function extractRawText(input: MammothBufferInput): Promise<MammothResult>;
}
