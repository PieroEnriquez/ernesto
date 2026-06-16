/**
 * Parse a Claude Code dynamic-workflow `.workflow.js` file: extract the
 * `export const meta = { ... }` literal block and return the body source
 * verbatim. The script body itself is opaque to fragua — we never
 * execute or transpile it; the Claude Code workflow runtime owns
 * execution.
 *
 * Claude Code's own validator requires `meta` to be a PURE LITERAL —
 * no computed values, no template interpolation, no function calls,
 * nothing that depends on runtime state. This parser enforces the
 * same constraint via a TypeScript AST walk, so a `.workflow.js` that
 * registers OK in the fragua registry is guaranteed to parse OK at
 * dispatch. (Without this, a workflow with `description: 'a' + 'b'`
 * would register but fail at the first Workflow tool call with
 * `SyntaxError: pure literal required`.)
 */

import * as ts from 'typescript';
import type { DynamicWorkflowMeta } from './types';

export interface ParsedDynamicWorkflow {
    meta: DynamicWorkflowMeta;
    scriptSource: string;
}

export class DynamicWorkflowParseError extends Error {
    constructor(
        message: string,
        public readonly line?: number,
    ) {
        super(message);
        this.name = 'DynamicWorkflowParseError';
    }
}

/**
 * Parse a `.workflow.js` file. Returns the extracted `meta` block and
 * passes the source through unchanged as `scriptSource`. Throws
 * `DynamicWorkflowParseError` on malformed input.
 */
export function parseDynamicWorkflowJs(source: string): ParsedDynamicWorkflow {
    const sf = ts.createSourceFile('workflow.js', source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.JS);

    const metaNode = findExportedMetaLiteral(sf);
    if (!metaNode) {
        throw new DynamicWorkflowParseError('no `export const meta = { ... }` declaration found');
    }

    const metaValue = parseLiteralExpression(metaNode);
    if (!isPlainObject(metaValue)) {
        throw new DynamicWorkflowParseError('`meta` must be an object literal', posLine(sf, metaNode));
    }

    validateMetaShape(metaValue, sf, metaNode);

    return {
        meta: metaValue as unknown as DynamicWorkflowMeta,
        scriptSource: source,
    };
}

// ─── AST walk ──────────────────────────────────────────────────────────────

function findExportedMetaLiteral(sf: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        const hasExport = !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!hasExport) continue;
        if (stmt.declarationList.declarations.length !== 1) continue;
        const decl = stmt.declarationList.declarations[0];
        if (!decl) continue;
        if (!ts.isIdentifier(decl.name)) continue;
        if (decl.name.text !== 'meta') continue;
        if (!decl.initializer) continue;
        if (ts.isObjectLiteralExpression(decl.initializer)) {
            return decl.initializer;
        }
        // `meta` exported as something other than an object literal —
        // the literal-only validator would reject this at dispatch time.
        throw new DynamicWorkflowParseError('`export const meta` must be initialized to an object literal', posLine(sf, decl.initializer));
    }
    return undefined;
}

function parseLiteralExpression(node: ts.Expression): unknown {
    // Primitives
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isNumericLiteral(node)) {
        return Number(node.text);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    // Negative numeric literals come through as PrefixUnaryExpression.
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
        return -Number(node.operand.text);
    }
    // Arrays
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.map((el) => {
            if (ts.isSpreadElement(el) || el.kind === ts.SyntaxKind.OmittedExpression) {
                throw new DynamicWorkflowParseError('spread / omitted elements are not allowed in `meta`');
            }
            return parseLiteralExpression(el);
        });
    }
    // Objects
    if (ts.isObjectLiteralExpression(node)) {
        const out: Record<string, unknown> = {};
        for (const prop of node.properties) {
            if (!ts.isPropertyAssignment(prop)) {
                throw new DynamicWorkflowParseError('shorthand / spread / method properties are not allowed in `meta`');
            }
            const key = readPropertyName(prop.name);
            out[key] = parseLiteralExpression(prop.initializer);
        }
        return out;
    }
    // Everything else (BinaryExpression, TemplateExpression, CallExpression,
    // Identifier, PropertyAccessExpression, etc.) violates the literal rule.
    throw new DynamicWorkflowParseError(`non-literal expression in \`meta\` (kind=${ts.SyntaxKind[node.kind]})`);
}

function readPropertyName(name: ts.PropertyName): string {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isNumericLiteral(name)) return name.text;
    throw new DynamicWorkflowParseError('computed property names are not allowed in `meta`');
}

// ─── Shape validation ──────────────────────────────────────────────────────

function validateMetaShape(meta: Record<string, unknown>, sf: ts.SourceFile, metaNode: ts.Node): void {
    if (typeof meta.name !== 'string' || meta.name.length === 0) {
        throw new DynamicWorkflowParseError('`meta.name` must be a non-empty string', posLine(sf, metaNode));
    }
    if (typeof meta.description !== 'string' || meta.description.length === 0) {
        throw new DynamicWorkflowParseError('`meta.description` must be a non-empty string', posLine(sf, metaNode));
    }
    if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') {
        throw new DynamicWorkflowParseError('`meta.whenToUse` must be a string when present');
    }
    if (meta.phases !== undefined) {
        if (!Array.isArray(meta.phases)) {
            throw new DynamicWorkflowParseError('`meta.phases` must be an array when present');
        }
        for (const [i, phase] of meta.phases.entries()) {
            if (!isPlainObject(phase)) {
                throw new DynamicWorkflowParseError(`\`meta.phases[${i}]\` must be an object`);
            }
            if (typeof phase.title !== 'string') {
                throw new DynamicWorkflowParseError(`\`meta.phases[${i}].title\` must be a string`);
            }
            if (typeof phase.detail !== 'string') {
                throw new DynamicWorkflowParseError(`\`meta.phases[${i}].detail\` must be a string`);
            }
        }
    }
    if (meta.model !== undefined && typeof meta.model !== 'string') {
        throw new DynamicWorkflowParseError('`meta.model` must be a string when present');
    }
    if (meta.includesErnestoBody !== undefined && typeof meta.includesErnestoBody !== 'boolean') {
        throw new DynamicWorkflowParseError('`meta.includesErnestoBody` must be a boolean when present');
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function posLine(sf: ts.SourceFile, node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
