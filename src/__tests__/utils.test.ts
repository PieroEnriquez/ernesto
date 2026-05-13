import { flattenResources } from '../utils';
import { ResourceNode } from '../types';

describe('flattenResources', () => {
    const makeNode = (id: string, children?: ResourceNode[]): ResourceNode => ({
        id,
        name: id,
        path: `/${id}`,
        content: `content-${id}`,
        ...(children && { children }),
    });

    it('returns empty array for empty input', () => {
        expect(flattenResources([])).toEqual([]);
    });

    it('returns flat list for resources with no children', () => {
        const resources = [makeNode('a'), makeNode('b')];
        const result = flattenResources(resources);
        expect(result).toHaveLength(2);
        expect(result.map(r => r.id)).toEqual(['a', 'b']);
    });

    it('flattens one level of nesting', () => {
        const resources = [
            makeNode('parent', [makeNode('child1'), makeNode('child2')]),
        ];
        const result = flattenResources(resources);
        expect(result).toHaveLength(3);
        expect(result.map(r => r.id)).toEqual(['parent', 'child1', 'child2']);
    });

    it('flattens deep recursive nesting', () => {
        const resources = [
            makeNode('l1', [
                makeNode('l2', [
                    makeNode('l3', [makeNode('l4')]),
                ]),
            ]),
        ];
        const result = flattenResources(resources);
        expect(result).toHaveLength(4);
        expect(result.map(r => r.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
    });
});
