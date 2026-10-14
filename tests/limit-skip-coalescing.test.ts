import {
    Decimal128,
    Double,
    Int32,
    Long,
} from 'mongodb';
import { describe, expect, it } from 'vitest';
import { optimizePipeline } from './helpers/pre-gate-optimizer.js';
import {
    LimitSkipCoalescingPass,
    proveLimitSkipCoalescing,
} from '../src/passes/limit-skip-coalescing.js';
import { optimizePipelineWithCandidateProfile } from '../src/passes/registry.js';
import {
    productionSemanticCases,
} from './fixtures/semantic-cases.js';
import { isEqual } from '../src/utils.js';

const LIMIT_SKIP = ['limit-skip-coalescing'] as const;

describe('limit and skip coalescing proof', () =>
{
    it('proves exact coalescing for valid JavaScript safe integers', () =>
    {
        expect(
            proveLimitSkipCoalescing({ $limit: 9 }, { $limit: 4 }),
        ).toEqual({
            operator: '$limit',
            leftValue: 9,
            rightValue: 4,
            coalescedValue: 4,
            replacementStage: { $limit: 4 },
        });
        expect(
            proveLimitSkipCoalescing({ $skip: 0 }, { $skip: 4 }),
        ).toEqual({
            operator: '$skip',
            leftValue: 0,
            rightValue: 4,
            coalescedValue: 4,
            replacementStage: { $skip: 4 },
        });
        expect(
            proveLimitSkipCoalescing(
                { $skip: Number.MAX_SAFE_INTEGER },
                { $skip: 0 },
            ),
        ).not.toBeNull();
    });

    it('rejects values MongoDB or JavaScript exactness cannot prove', () =>
    {
        const wrappers = [
            Long.fromNumber(2),
            Decimal128.fromString('2'),
            new Int32(2),
            new Double(2),
            new Number(2),
        ];
        const sharedInvalid = [
            '2',
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            2n,
            ...wrappers,
        ];

        for (const value of [...sharedInvalid, 0, -1])
        {
            expect(
                proveLimitSkipCoalescing({ $limit: value }, { $limit: 2 }),
            ).toBeNull();
            expect(
                proveLimitSkipCoalescing({ $limit: 2 }, { $limit: value }),
            ).toBeNull();
        }

        for (const value of [...sharedInvalid, -1])
        {
            expect(
                proveLimitSkipCoalescing({ $skip: value }, { $skip: 2 }),
            ).toBeNull();
            expect(
                proveLimitSkipCoalescing({ $skip: 2 }, { $skip: value }),
            ).toBeNull();
        }

        expect(
            proveLimitSkipCoalescing(
                { $skip: Number.MAX_SAFE_INTEGER },
                { $skip: 1 },
            ),
        ).toBeNull();
    });

    it('requires adjacent strict one-key stages of the same kind', () =>
    {
        const pairs: readonly [unknown, unknown][] = [
            [{}, { $limit: 1 }],
            [{ $limit: 1 }, {}],
            [{ $limit: 1, extra: true }, { $limit: 1 }],
            [{ $skip: 1 }, { $limit: 1 }],
            [{ $limit: 1 }, { $skip: 1 }],
            [null, { $skip: 1 }],
            [[{ $skip: 1 }], { $skip: 1 }],
            [{ $limit: 1 }, Object.assign(new Date(0), { $limit: 1 })],
        ];

        for (const [left, right] of pairs)
        {
            expect(proveLimitSkipCoalescing(left, right)).toBeNull();
        }
    });
});

describe('limit and skip coalescing scheduling', () =>
{
    it('performs one adjacent rewrite per pass execution', () =>
    {
        const pipeline = [
            { $limit: 9 },
            { $limit: 7 },
            { $limit: 5 },
        ];

        expect(new LimitSkipCoalescingPass().execute(pipeline)).toEqual([
            { $limit: 7 },
            { $limit: 5 },
        ]);
        expect(
            optimizePipelineWithCandidateProfile(pipeline, LIMIT_SKIP, []),
        ).toEqual([
            { $limit: 5 },
        ]);
        expect(
            new LimitSkipCoalescingPass().execute(pipeline, {
                strictFieldOrder: true,
                strictErrors: true,
            }),
        ).toEqual([
            { $limit: 7 },
            { $limit: 5 },
        ]);

        expect(
            new LimitSkipCoalescingPass().execute([
                { $match: { status: 'active' } },
                { $skip: 0 },
                { $limit: 5 },
            ]),
        ).toEqual([
            { $match: { status: 'active' } },
            { $limit: 5 },
        ]);

        // Normalizes { $limit: L }, { $skip: S } (with L > S > 0) into { $skip: S }, { $limit: L - S }
        expect(
            new LimitSkipCoalescingPass().execute([
                { $limit: 10 },
                { $skip: 3 },
            ]),
        ).toEqual([
            { $skip: 3 },
            { $limit: 7 },
        ]);

        // Coalesces multi-layer pagination chains to a fixed point
        expect(
            optimizePipelineWithCandidateProfile(
                [
                    { $skip: 10 },
                    { $limit: 20 },
                    { $skip: 5 },
                    { $limit: 10 },
                ],
                LIMIT_SKIP,
                [],
            ),
        ).toEqual([
            { $skip: 15 },
            { $limit: 10 },
        ]);

        // Leaves { $limit: L }, { $skip: S } untouched when S >= L
        expect(
            optimizePipelineWithCandidateProfile(
                [
                    { $limit: 5 },
                    { $skip: 5 },
                ],
                LIMIT_SKIP,
                [],
            ),
        ).toEqual([
            { $limit: 5 },
            { $skip: 5 },
        ]);

        // Eliminates redundant downstream $limit across non-expanding stages
        expect(
            new LimitSkipCoalescingPass().execute([
                { $limit: 5 },
                { $match: { status: 'active' } },
                { $project: { name: 1 } },
                { $limit: 10 },
            ]),
        ).toEqual([
            { $limit: 5 },
            { $match: { status: 'active' } },
            { $project: { name: 1 } },
        ]);

        // Accounts for intermediate $skip stages when checking downstream $limit redundancy
        expect(
            new LimitSkipCoalescingPass().execute([
                { $limit: 10 },
                { $match: { status: 'active' } },
                { $skip: 4 },
                { $limit: 6 },
            ]),
        ).toEqual([
            { $limit: 10 },
            { $match: { status: 'active' } },
            { $skip: 4 },
        ]);

        // Keeps downstream $limit when strictly tighter than upstream cap minus skips, or across $unwind
        expect(
            new LimitSkipCoalescingPass().execute([
                { $limit: 10 },
                { $match: { status: 'active' } },
                { $skip: 4 },
                { $limit: 5 },
            ]),
        ).toEqual([
            { $limit: 10 },
            { $match: { status: 'active' } },
            { $skip: 4 },
            { $limit: 5 },
        ]);

        expect(
            new LimitSkipCoalescingPass().execute([
                { $limit: 5 },
                { $unwind: '$items' },
                { $limit: 10 },
            ]),
        ).toEqual([
            { $limit: 5 },
            { $unwind: '$items' },
            { $limit: 10 },
        ]);
    });

    it('preserves every unproved value and the caller input', () =>
    {
        const pipeline = [
            { $limit: '10' },
            { $limit: 5 },
            { $skip: Number.MAX_SAFE_INTEGER },
            { $skip: 1 },
            { $skip: Long.fromNumber(2) },
            { $skip: 3 },
            { $limit: 4, malformed: true },
            { $limit: 2 },
        ];
        const snapshot = structuredClone(pipeline);

        expect(
            optimizePipelineWithCandidateProfile(pipeline, LIMIT_SKIP, []),
        ).toEqual(pipeline);
        expect(pipeline).toEqual(snapshot);
    });

    it('is active, nested, immutable, and stable after one public call', () =>
    {
        const pipeline = [
            { $skip: 1 },
            { $skip: 2 },
            {
                $facet: {
                    limited: [
                        { $limit: 8 },
                        { $limit: 3 },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'foreign',
                    pipeline: [
                        { $skip: 2 },
                        { $skip: 4 },
                    ],
                    as: 'joined',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $limit: 6 },
                        { $limit: 2 },
                    ],
                },
            },
        ];
        const snapshot = structuredClone(pipeline);

        const once = optimizePipeline(pipeline);
        const twice = optimizePipeline(once);

        expect(pipeline).toEqual(snapshot);
        expect(once).toEqual([
            { $skip: 3 },
            {
                $facet: {
                    limited: [
                        { $limit: 3 },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'foreign',
                    pipeline: [
                        { $skip: 6 },
                    ],
                    as: 'joined',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $limit: 2 },
                    ],
                },
            },
        ]);
        expect(twice).toEqual(once);
    });

    it('owns focused safe, nested, overflow, and invalid server fixtures', () =>
    {
        const fixtures = productionSemanticCases.filter((testCase) =>
            testCase.id.startsWith('u9-limit-skip-'),
        );
        const classifications = Object.fromEntries(fixtures.map((testCase) =>
        {
            expect(testCase.kind).toBe('pipeline');
            if (testCase.kind !== 'pipeline')
            {
                return [testCase.id, 'invalid-test-fixture'];
            }

            const optimized = optimizePipeline(testCase.pipeline as any[]);
            return [
                testCase.id,
                isEqual( optimized, testCase.pipeline )
                    ? 'barrier'
                    : 'rewrite',
            ];
        }));

        expect(classifications).toEqual({
            'u9-limit-skip-safe-top-level': 'rewrite',
            'u9-limit-skip-safe-nested': 'rewrite',
            'u9-limit-skip-preservation-barriers': 'barrier',
            'u9-limit-skip-invalid-value-barriers': 'barrier',
        });
    });
});
