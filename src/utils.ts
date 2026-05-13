/**
 * Ernesto utilities
 */

import { ResourceNode } from './types';

/**
 * Flatten nested resources into a single array
 */
export function flattenResources(resources: ResourceNode[]): ResourceNode[] {
    const result: ResourceNode[] = [];
    for (const resource of resources) {
        result.push(resource);
        if (resource.children) {
            result.push(...flattenResources(resource.children));
        }
    }
    return result;
}
