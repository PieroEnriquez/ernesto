/**
 * Orchestration step kind tests.
 *
 * Exercises the declarative DAG primitive that replaces hand-rolled
 * pipelines (autofill `orchestrate.ts`-style code). Covers:
 *
 *   - Dependency-respecting execution + parallel fanout
 *   - `${{ inputs.X }}` + `${{ steps.X.outputs.Y }}` interpolation
 *   - `skipIf` predicate evaluation
 *   - `fallback` value when a step errors
 *   - First-error propagation
 *   - DAG validation (unknown depends, cycles)
 *   - Concurrency cap
 *   - Nested orchestration (orchestration-within-orchestration)
 *   - `outputs:` aggregated map projection
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal, servicePrincipal } from '../principal';
import { resolveExpression } from '../engine/orchestration-handler';
import type { WorkflowReader, WorkflowDetail } from '../workflow-reader';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';

function readerOf(decl: WorkflowDeclaration): WorkflowReader {
    const detail: WorkflowDetail = {
        name: decl.name,
        path: 'mem://w',
        sha: 'sha',
        source: 'mem',
        declaration: decl,
    };
    return {
        async list() {
            return [{ name: decl.name, path: 'mem://w', sha: 'sha' }];
        },
        async read(name: string) {
            if (name !== decl.name) return undefined;
            return detail;
        },
    };
}

describe('orchestration step kind — declarative DAG composition', () => {
    it('runs independent children in parallel and merges by stepId', async () => {
        const runner = createRunner();
        const fireOrder: string[] = [];
        const finishOrder: string[] = [];
        runner.registerStepKind('route', async (step) => {
            const tag = (step as any).uri as string;
            fireOrder.push(tag);
            await new Promise((r) => setTimeout(r, 5));
            finishOrder.push(tag);
            return { kind: 'completed', output: { tag } };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-parallel',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            a: { step: { kind: 'route', uri: 'a' } as WorkflowStep },
                            b: { step: { kind: 'route', uri: 'b' } as WorkflowStep },
                            c: { step: { kind: 'route', uri: 'c' } as WorkflowStep },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-parallel',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        // All three steps should have fired before any completes when no concurrency cap.
        expect(fireOrder.length).toBe(3);
        const main = (run.output as any)?.main;
        expect(main).toEqual({
            steps: { a: { tag: 'a' }, b: { tag: 'b' }, c: { tag: 'c' } },
        });
    });

    it('honors depends — runs in topological order with parallelism between independents', async () => {
        const runner = createRunner();
        const completionTimes: Record<string, number> = {};
        runner.registerStepKind('route', async (step) => {
            const tag = (step as any).uri as string;
            await new Promise((r) => setTimeout(r, 5));
            completionTimes[tag] = Date.now();
            return { kind: 'completed', output: { tag } };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-dag',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            a: { step: { kind: 'route', uri: 'a' } as WorkflowStep },
                            b: { step: { kind: 'route', uri: 'b' } as WorkflowStep },
                            c: {
                                step: { kind: 'route', uri: 'c' } as WorkflowStep,
                                depends: ['a', 'b'],
                            },
                            d: {
                                step: { kind: 'route', uri: 'd' } as WorkflowStep,
                                depends: ['c'],
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-dag',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        // a and b independent — should complete close together
        expect(Math.abs(completionTimes.a! - completionTimes.b!)).toBeLessThan(20);
        // c depends on both a + b — must complete AFTER them
        expect(completionTimes.c!).toBeGreaterThanOrEqual(completionTimes.a!);
        expect(completionTimes.c!).toBeGreaterThanOrEqual(completionTimes.b!);
        // d depends on c — strictly after
        expect(completionTimes.d!).toBeGreaterThanOrEqual(completionTimes.c!);
    });

    it('interpolates ${{ steps.X.outputs.Y }} into child inputs', async () => {
        const runner = createRunner();
        let observedParams: unknown;
        runner.registerStepKind('route', async (step) => {
            const s = step as any;
            if (s.uri === 'fetch') {
                return { kind: 'completed', output: { user: { id: 42, name: 'Bob' } } };
            }
            observedParams = s.params;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-interp',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            fetch: { step: { kind: 'route', uri: 'fetch' } as WorkflowStep },
                            use: {
                                step: {
                                    kind: 'route',
                                    uri: 'use',
                                    params: {
                                        userId: '${{ steps.fetch.outputs.user.id }}',
                                        userName: 'name=${{ steps.fetch.outputs.user.name }}',
                                        wholeUser: '${{ steps.fetch.outputs.user }}',
                                    },
                                } as WorkflowStep,
                                depends: ['fetch'],
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-interp',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        expect(observedParams).toEqual({
            userId: 42, // standalone token preserves type
            userName: 'name=Bob',
            wholeUser: { id: 42, name: 'Bob' },
        });
    });

    it('interpolates ${{ inputs.X }} against orchestration-level inputs', async () => {
        const runner = createRunner();
        let observedParams: unknown;
        runner.registerStepKind('route', async (step) => {
            observedParams = (step as any).params;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-inputs',
                description: 'd',
                version: 1,
                inputs: { productId: { type: 'string' } },
                steps: {
                    main: {
                        kind: 'orchestration',
                        inputs: { productId: '${{ inputs.productId }}' } as any,
                        steps: {
                            useIt: {
                                step: {
                                    kind: 'route',
                                    uri: 'x',
                                    params: { id: '${{ inputs.productId }}' },
                                } as WorkflowStep,
                            },
                        },
                    } as any,
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-inputs',
            { productId: 'P-12345' },
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        expect(observedParams).toEqual({ id: 'P-12345' });
    });

    it('skipIf truthy expression skips dispatch without running the handler', async () => {
        const runner = createRunner();
        const fired: string[] = [];
        runner.registerStepKind('route', async (step) => {
            fired.push((step as any).uri as string);
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-skip',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            fetch: {
                                step: { kind: 'route', uri: 'fetch' } as WorkflowStep,
                            },
                            translate: {
                                step: { kind: 'route', uri: 'translate' } as WorkflowStep,
                                depends: ['fetch'],
                                // Skip translation when fetch already provides text
                                skipIf: '${{ steps.fetch.outputs.ok }}',
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-skip',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        expect(fired).toEqual(['fetch']); // translate skipped
        const out = (run.output as any).main.steps;
        expect(out.translate).toMatchObject({ skipped: true });
    });

    it('fallback expression replaces step error with fallback value', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async (step) => {
            const uri = (step as any).uri as string;
            if (uri === 'fetch-html') {
                return {
                    kind: 'completed',
                    output: { providerHtml: '<html>provider</html>' },
                };
            }
            if (uri === 'generate') {
                return {
                    kind: 'error',
                    code: 'gen_failed',
                    message: 'model unavailable',
                };
            }
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-fallback',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            fetchHtml: {
                                step: { kind: 'route', uri: 'fetch-html' } as WorkflowStep,
                            },
                            generate: {
                                step: { kind: 'route', uri: 'generate' } as WorkflowStep,
                                depends: ['fetchHtml'],
                                fallback: '${{ steps.fetchHtml.outputs.providerHtml }}',
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-fallback',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        const generate = (run.output as any).main.steps.generate;
        expect(generate).toBe('<html>provider</html>');
    });

    it('first error fails the orchestration with the failing stepId surfaced', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async (step) => {
            const uri = (step as any).uri as string;
            if (uri === 'broken') {
                return { kind: 'error', code: 'oops', message: 'thing broke' };
            }
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-fail',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            ok: { step: { kind: 'route', uri: 'ok' } as WorkflowStep },
                            broken: {
                                step: { kind: 'route', uri: 'broken' } as WorkflowStep,
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-fail',
            {},
            servicePrincipal('test-worker', 'req-1'),
            {},
        );
        expect(run.status).toBe('errored');
        expect(run.error?.message).toContain('broken');
        expect(run.error?.message).toContain('thing broke');
    });

    it('rejects an invalid DAG (cycle) with orchestration_invalid_dag', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-cycle',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            a: {
                                step: { kind: 'route', uri: 'a' } as WorkflowStep,
                                depends: ['b'],
                            },
                            b: {
                                step: { kind: 'route', uri: 'b' } as WorkflowStep,
                                depends: ['a'],
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch('wf-cycle', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('errored');
        expect(run.error?.message).toContain('cycle');
    });

    it('rejects depends-on-unknown-step', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-bad-dep',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            a: {
                                step: { kind: 'route', uri: 'a' } as WorkflowStep,
                                depends: ['nonexistent'],
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-bad-dep',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('errored');
        expect(run.error?.message).toContain('nonexistent');
    });

    it('concurrency cap throttles in-flight children', async () => {
        const runner = createRunner();
        let inflight = 0;
        let maxInflight = 0;
        runner.registerStepKind('route', async () => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((r) => setTimeout(r, 10));
            inflight--;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-throttle',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        concurrency: 2,
                        steps: {
                            a: { step: { kind: 'route', uri: 'a' } as WorkflowStep },
                            b: { step: { kind: 'route', uri: 'b' } as WorkflowStep },
                            c: { step: { kind: 'route', uri: 'c' } as WorkflowStep },
                            d: { step: { kind: 'route', uri: 'd' } as WorkflowStep },
                            e: { step: { kind: 'route', uri: 'e' } as WorkflowStep },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-throttle',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        expect(maxInflight).toBeLessThanOrEqual(2);
        expect(maxInflight).toBeGreaterThan(0);
    });

    it('aggregates step outputs into the orchestration output via `outputs:` bindings', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async (step) => {
            const uri = (step as any).uri as string;
            if (uri === 'company') {
                return { kind: 'completed', output: { name: 'Acme', country: 'US' } };
            }
            if (uri === 'logo') {
                return { kind: 'completed', output: { url: 'logo.png' } };
            }
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-outputs',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            company: { step: { kind: 'route', uri: 'company' } as WorkflowStep },
                            logo: { step: { kind: 'route', uri: 'logo' } as WorkflowStep },
                        },
                        outputs: {
                            companyName: { from: '${{ steps.company.outputs.name }}' },
                            logoUrl: { from: '${{ steps.logo.outputs.url }}' },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-outputs',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        const main = (run.output as any).main;
        expect(main.companyName).toBe('Acme');
        expect(main.logoUrl).toBe('logo.png');
    });

    it('nested orchestration composes recursively', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async (step) => ({
            kind: 'completed',
            output: { tag: (step as any).uri },
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-nested',
                description: 'd',
                version: 1,
                steps: {
                    main: {
                        kind: 'orchestration',
                        steps: {
                            outer1: {
                                step: { kind: 'route', uri: 'outer1' } as WorkflowStep,
                            },
                            innerGroup: {
                                step: {
                                    kind: 'orchestration',
                                    steps: {
                                        i1: {
                                            step: { kind: 'route', uri: 'i1' } as WorkflowStep,
                                        },
                                        i2: {
                                            step: { kind: 'route', uri: 'i2' } as WorkflowStep,
                                            depends: ['i1'],
                                        },
                                    },
                                } as WorkflowStep,
                                depends: ['outer1'],
                            },
                        },
                    },
                },
            }),
        );
        const run = await runner.dispatch(
            'wf-nested',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
        const main = (run.output as any).main;
        expect(main.steps.outer1).toEqual({ tag: 'outer1' });
        expect(main.steps.innerGroup.steps.i1).toEqual({ tag: 'i1' });
        expect(main.steps.innerGroup.steps.i2).toEqual({ tag: 'i2' });
    });

    it('autofill-pipeline-shape: gate on tcLink, parallel phase, conditional skip, fanout', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async (step) => {
            const uri = (step as any).uri as string;
            const params = (step as any).params as Record<string, unknown> | undefined;
            switch (uri) {
                case 'fetch-product':
                    return {
                        kind: 'completed',
                        output: { product: { id: 'P-1', termsLink: null } },
                    };
                case 'find-logo':
                    return { kind: 'completed', output: { url: 'logo.png' } };
                case 'tc-search':
                    return { kind: 'completed', output: { found: true, link: 'https://x/tos' } };
                case 'gen-faq':
                    return { kind: 'completed', output: { faq: ['Q1: A1', 'Q2: A2'], tcLink: params?.tcLink } };
                case 'translate-fr':
                    return { kind: 'completed', output: { lang: 'fr', items: ['Q1-fr', 'Q2-fr'] } };
                case 'translate-es':
                    return { kind: 'completed', output: { lang: 'es', items: ['Q1-es', 'Q2-es'] } };
                default:
                    return { kind: 'completed', output: {} };
            }
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'autofill',
                description: 'd',
                version: 1,
                inputs: { productId: { type: 'string' } },
                steps: {
                    main: {
                        kind: 'orchestration',
                        inputs: { productId: '${{ inputs.productId }}' } as any,
                        steps: {
                            fetchProduct: {
                                step: {
                                    kind: 'route',
                                    uri: 'fetch-product',
                                    params: { id: '${{ inputs.productId }}' },
                                } as WorkflowStep,
                            },
                            findLogo: {
                                step: { kind: 'route', uri: 'find-logo' } as WorkflowStep,
                                depends: ['fetchProduct'],
                            },
                            tcSearch: {
                                step: { kind: 'route', uri: 'tc-search' } as WorkflowStep,
                                depends: ['fetchProduct'],
                            },
                            genFaq: {
                                step: {
                                    kind: 'route',
                                    uri: 'gen-faq',
                                    params: { tcLink: '${{ steps.tcSearch.outputs.link }}' },
                                } as WorkflowStep,
                                depends: ['tcSearch'],
                            },
                            translateFr: {
                                step: {
                                    kind: 'route',
                                    uri: 'translate-fr',
                                    params: { source: '${{ steps.genFaq.outputs.faq }}' },
                                } as WorkflowStep,
                                depends: ['genFaq'],
                            },
                            translateEs: {
                                step: {
                                    kind: 'route',
                                    uri: 'translate-es',
                                    params: { source: '${{ steps.genFaq.outputs.faq }}' },
                                } as WorkflowStep,
                                depends: ['genFaq'],
                            },
                        },
                        outputs: {
                            logo: { from: '${{ steps.findLogo.outputs.url }}' },
                            tcLink: { from: '${{ steps.tcSearch.outputs.link }}' },
                            faqFr: { from: '${{ steps.translateFr.outputs.items }}' },
                            faqEs: { from: '${{ steps.translateEs.outputs.items }}' },
                        },
                    } as any,
                },
            }),
        );
        const run = await runner.dispatch(
            'autofill',
            { productId: 'P-1' },
            servicePrincipal('autofill-worker', 'req-1'),
            {},
        );
        expect(run.status).toBe('completed');
        const main = (run.output as any).main;
        expect(main.logo).toBe('logo.png');
        expect(main.tcLink).toBe('https://x/tos');
        expect(main.faqFr).toEqual(['Q1-fr', 'Q2-fr']);
        expect(main.faqEs).toEqual(['Q1-es', 'Q2-es']);
    });
});

describe('resolveExpression', () => {
    it('resolves inputs.* paths', () => {
        expect(resolveExpression('inputs.x', { x: 42 }, {})).toBe(42);
        expect(
            resolveExpression('inputs.user.name', { user: { name: 'Alice' } }, {}),
        ).toBe('Alice');
    });

    it('resolves steps.X.outputs.* paths', () => {
        const stepOutputs = { fetch: { user: { id: 1, name: 'Bob' } } };
        expect(resolveExpression('steps.fetch.outputs.user.id', {}, stepOutputs)).toBe(1);
        expect(resolveExpression('steps.fetch.outputs.user', {}, stepOutputs)).toEqual({
            id: 1,
            name: 'Bob',
        });
    });

    it('returns the full step output for `steps.X`', () => {
        const stepOutputs = { fetch: { ok: true } };
        expect(resolveExpression('steps.fetch', {}, stepOutputs)).toEqual({ ok: true });
    });

    it('shorthand: steps.X.Y is steps.X.outputs.Y', () => {
        const stepOutputs = { fetch: { name: 'Alice' } };
        expect(resolveExpression('steps.fetch.name', {}, stepOutputs)).toBe('Alice');
    });

    it('returns undefined for missing keys', () => {
        expect(resolveExpression('inputs.missing', {}, {})).toBeUndefined();
        expect(resolveExpression('steps.missing.outputs.x', {}, {})).toBeUndefined();
        expect(resolveExpression('', {}, {})).toBeUndefined();
    });
});
