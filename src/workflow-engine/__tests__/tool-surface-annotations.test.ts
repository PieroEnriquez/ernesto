import { describe, it, expect } from 'vitest';
import {
    TOOL_SURFACE_ANNOTATIONS,
    readDisallowedToolsExtra,
    readSystemPromptExtras,
} from '../middleware/tool-surface-compose';

describe('TOOL_SURFACE_ANNOTATIONS', () => {
    it('exports the canonical annotation key strings', () => {
        expect(TOOL_SURFACE_ANNOTATIONS.DISALLOWED_TOOLS_EXTRA).toBe('disallowedToolsExtra');
        expect(TOOL_SURFACE_ANNOTATIONS.SYSTEM_PROMPT_EXTRAS).toBe('systemPromptExtras');
    });
});

describe('readDisallowedToolsExtra', () => {
    it('returns string array when annotation is a string array', () => {
        const result = readDisallowedToolsExtra({
            disallowedToolsExtra: ['TaskCreate', 'TaskUpdate'],
        });
        expect(result).toEqual(['TaskCreate', 'TaskUpdate']);
    });

    it('returns empty array when annotation is absent', () => {
        expect(readDisallowedToolsExtra({})).toEqual([]);
    });

    it('returns empty array when annotation is non-array', () => {
        expect(readDisallowedToolsExtra({ disallowedToolsExtra: 'TaskCreate' as never })).toEqual([]);
        expect(readDisallowedToolsExtra({ disallowedToolsExtra: 42 as never })).toEqual([]);
    });

    it('filters non-string entries', () => {
        const result = readDisallowedToolsExtra({
            disallowedToolsExtra: ['TaskCreate', 42, null, 'TaskUpdate'] as never,
        });
        expect(result).toEqual(['TaskCreate', 'TaskUpdate']);
    });
});

describe('readSystemPromptExtras', () => {
    it('returns string array when annotation is a string array', () => {
        const result = readSystemPromptExtras({
            systemPromptExtras: ['hint A', 'hint B'],
        });
        expect(result).toEqual(['hint A', 'hint B']);
    });

    it('returns empty array when annotation is absent', () => {
        expect(readSystemPromptExtras({})).toEqual([]);
    });

    it('filters non-string entries', () => {
        const result = readSystemPromptExtras({
            systemPromptExtras: ['ok', 42, undefined, 'fine'] as never,
        });
        expect(result).toEqual(['ok', 'fine']);
    });
});
