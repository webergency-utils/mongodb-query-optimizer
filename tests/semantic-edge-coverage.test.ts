import { describe, expect, it } from 'vitest';
import {
    analyzeExpression,
    cloneDependencies,
    createDependencies,
    mergeDependencies,
} from '../src/analyzer/expressions.js';
import {
    analyzeFilter,
    isFilterRewriteSafe,
} from '../src/analyzer/filters.js';
import {
    anyPathCovers,
    exactPath,
    pathCovers,
    pathsOverlap,
    relatePathEffects,
    relatePaths,
    removedPath,
} from '../src/analyzer/paths.js';
import {
    analyzeProjection,
    projectionVisibility,
} from '../src/analyzer/projections.js';
import {
    analyzePipeline,
    analyzeStage,
    joinCardinality,
    joinOrder,
    joinProvenance,
} from '../src/analyzer/semantics.js';
import {
    proveLimitAdvanceAcrossStage,
    proveMatchPushdownAcrossStage,
    provePrioritySwap,
    proveRedundantLookupElimination,
} from '../src/passes/movement-proofs.js';
import {
    isExactPathDiscardedByFollower,
    proveAdjacentAddFieldMerge,
    proveAdjacentProjectMerge,
    proveAddFieldDeferralAcrossSort,
    proveSimpleProjectAdvanceAcrossSort,
    proveUnusedFieldPruning,
    proveUnusedFieldPruningThroughSuffix,
} from '../src/passes/projection-proofs.js';

describe('semantic analyzer edge behavior', () =>
{
    it('merges and clones repeated variable dependency buckets independently', () =>
    {
        const target = createDependencies();
        const source = createDependencies();
        target.variables.set('shared', new Set(['first']));
        source.variables.set('shared', new Set(['second']));
        source.local.add('local.path');

        mergeDependencies(target, source);
        expect(target.variables.get('shared')).toEqual(new Set([
            'first',
            'second',
        ]));

        const clone = cloneDependencies(target);
        clone.variables.get('shared')!.add('third');
        clone.local.add('clone.only');
        expect(target.variables.get('shared')).toEqual(new Set([
            'first',
            'second',
        ]));
        expect(target.local.has('clone.only')).toBe(false);
    });

    it('resolves repeated, trailing, builtin, and unusual variable bindings conservatively', () =>
    {
        const variables = new Map([
            ['path', { scope: 'local' as const, path: 'source' }],
            ['whole', { scope: 'local' as const, wholeDocument: true }],
            ['unknown', { scope: 'local' as const, unknown: true }],
            ['bare', { scope: 'local' as const }],
        ]);
        const summary = analyzeExpression([
            '$$path',
            '$$path.child',
            '$$path.',
            '$$whole.child',
            '$$unknown.child',
            '$$bare.child',
            '$$unbound.first',
            '$$unbound.second',
            '$$NOW',
        ], {
            documentScope: 'local',
            variables,
        });

        expect(summary.dependencies.local).toEqual(new Set([
            'source',
            'source.child',
            'child',
            '*',
        ]));
        expect(summary.dependencies.variables.get('unbound')).toEqual(new Set([
            'first',
            'second',
        ]));
        expect(summary.dependencies.variables.has('NOW')).toBe(false);
        expect(summary.dependencies.unknown).toBe(true);
        expect(summary.unknown).toBe(true);
    });

    it('treats empty field references and missing getField operands as unknown', () =>
    {
        const emptyReference = analyzeExpression('$');
        expect(emptyReference.dependencies.local).toEqual(new Set(['*']));
        expect(emptyReference.unknown).toBe(true);

        const missingField = analyzeExpression({
            $getField: {
                input: '$profile',
            },
        });
        expect(missingField.dependencies.local).toEqual(new Set(['*']));
        expect(missingField.unknown).toBe(true);

        const constantField = analyzeExpression({ $getField: 'profile' });
        expect(constantField.dependencies.local).toEqual(new Set(['profile']));
        expect(constantField.errors).toBe('may-error');
    });

    it('infers getField input bindings without inventing precise paths', () =>
    {
        const variables = new Map([
            ['path', { scope: 'local' as const, path: 'profile' }],
            ['whole', { scope: 'local' as const, wholeDocument: true }],
            ['bare', { scope: 'local' as const }],
        ]);
        const summary = analyzeExpression([
            { $getField: { field: 'name' } },
            { $getField: { field: 'leaf', input: '$$path' } },
            { $getField: { field: 'leaf', input: '$$path.child' } },
            { $getField: { field: 'leaf', input: '$$ROOT.profile' } },
            { $getField: { field: 'leaf', input: '$$whole.child' } },
            { $getField: { field: 'leaf', input: '$$bare.child' } },
            { $getField: { field: 'leaf', input: { literal: true } } },
        ], {
            documentScope: 'local',
            variables,
        });

        expect(summary.dependencies.local).toEqual(new Set([
            'name',
            'profile',
            'profile.leaf',
            'profile.child',
            'profile.child.leaf',
            'child',
            'child.leaf',
            '*',
        ]));
        expect(summary.dependencies.unknown).toBe(true);
    });

    it('tracks valid let, map, filter, and reduce scopes', () =>
    {
        const letSummary = analyzeExpression({
            $let: {
                vars: {
                    item: '$source',
                },
                in: '$$item.value',
            },
        });
        expect(letSummary.dependencies.local).toEqual(new Set([
            'source',
            'source.value',
        ]));
        expect(letSummary.unknown).toBe(false);
        expect(letSummary.errors).toBe('may-error');

        const mapSummary = analyzeExpression({
            $map: {
                input: '$items',
                as: 'item',
                in: '$$item.price',
            },
        });
        expect(mapSummary.dependencies.local).toEqual(new Set([
            'items',
            'items.price',
        ]));
        expect(mapSummary.errors).toBe('may-error');

        const filterSummary = analyzeExpression({
            $filter: {
                input: '$items',
                cond: '$$this.active',
                limit: '$maximum',
            },
        }, {
            documentScope: 'local',
            variables: new Map(),
        });
        expect(filterSummary.dependencies.local).toEqual(new Set([
            'items',
            'items.active',
            'maximum',
        ]));
        expect(filterSummary.errors).toBe('may-error');

        const reduceSummary = analyzeExpression({
            $reduce: {
                input: '$items',
                initialValue: '$seed',
                in: ['$$this.price', '$$value.total'],
            },
        }, {
            documentScope: 'local',
            variables: new Map(),
        });
        expect(reduceSummary.dependencies.local).toEqual(new Set([
            'items',
            'seed',
            'items.price',
            '*',
        ]));
        expect(reduceSummary.dependencies.unknown).toBe(true);
        expect(reduceSummary.errors).toBe('may-error');

        const constantReduce = analyzeExpression({
            $reduce: {
                input: [],
                initialValue: 0,
                in: 0,
            },
        });
        expect(constantReduce.dependencies.local).toEqual(new Set());
        expect(constantReduce.unknown).toBe(false);
        expect(constantReduce.errors).toBe('may-error');
    });

    it('marks malformed scoped expressions unknown at the failed obligation', () =>
    {
        const malformedExpressions = [
            { $let: null },
            { $let: { vars: null, in: 1 } },
            { $let: { vars: {} } },
            { $map: null },
            { $map: {} },
            { $map: { input: '$items' } },
            { $filter: { input: '$items' } },
            { $reduce: null },
            { $reduce: { input: '$items' } },
            { $reduce: { input: '$items', initialValue: 0 } },
        ];

        for (const expression of malformedExpressions)
        {
            const summary = analyzeExpression(expression);
            expect(summary.unknown).toBe(true);
            expect(summary.dependencies.local.has('*')).toBe(true);
        }
    });

    it('keeps invalid functions, exotic objects, and mixed operator documents conservative', () =>
    {
        const invalidFunction = analyzeExpression({ $function: null });
        expect(invalidFunction.determinism).toBe('unknown');
        expect(invalidFunction.errors).toBe('unknown');
        expect(invalidFunction.unknown).toBe(true);

        const invalidFunctionArguments = analyzeExpression({
            $function: {
                args: '$value',
            },
        });
        expect(invalidFunctionArguments.errors).toBe('unknown');
        expect(invalidFunctionArguments.unknown).toBe(true);

        const invalidAccumulatorArguments = analyzeExpression({
            $accumulator: {
                initArgs: [],
                accumulateArgs: '$value',
            },
        });
        expect(invalidAccumulatorArguments.errors).toBe('unknown');
        expect(invalidAccumulatorArguments.unknown).toBe(true);

        const date = new Date('2026-01-01T00:00:00.000Z');
        expect(analyzeExpression(date)).toMatchObject({
            determinism: 'deterministic',
            errors: 'none-known',
            unknown: false,
        });

        const mixed = analyzeExpression({
            $add: ['$price', 1],
            metadata: '$category',
        });
        expect(mixed.dependencies.local).toEqual(new Set([
            'price',
            'category',
            '*',
        ]));
        expect(mixed.unknown).toBe(true);
    });

    it('accepts null-prototype expression documents as ordinary documents', () =>
    {
        const expression = Object.assign(Object.create(null) as Record<string, unknown>, {
            value: '$source',
        });
        const summary = analyzeExpression(expression);

        expect(summary.dependencies.local).toEqual(new Set(['source']));
        expect(summary.unknown).toBe(false);
    });
});

describe('filter rewrite-safety edge behavior', () =>
{
    it('rejects cyclic BSON literals but accepts finite arrays and null-prototype documents', () =>
    {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(isFilterRewriteSafe({ value: { $eq: cyclic } })).toBe(false);

        const literal = Object.assign(Object.create(null) as Record<string, unknown>, {
            nested: [1, 'two', null],
        });
        expect(isFilterRewriteSafe({ value: { $eq: literal } })).toBe(true);
        expect(isFilterRewriteSafe({ value: { $eq: [1, { nested: true }] } })).toBe(true);
    });

    it('validates regex, type, existence, options, size, and modulo operands', () =>
    {
        const bsonRegex = { _bsontype: 'BSONRegExp', pattern: '^ok' };
        for (const operand of ['^ok', /^ok/, bsonRegex])
        {
            expect(isFilterRewriteSafe({ value: { $regex: operand } })).toBe(true);
        }
        for (const operand of [null, 7, { _bsontype: 'Other' }])
        {
            expect(isFilterRewriteSafe({ value: { $regex: operand } })).toBe(false);
        }

        for (const operand of ['string', 2, ['string', 2]])
        {
            expect(isFilterRewriteSafe({ value: { $type: operand } })).toBe(true);
        }
        for (const operand of [true, [], ['string', false]])
        {
            expect(isFilterRewriteSafe({ value: { $type: operand } })).toBe(false);
        }

        expect(isFilterRewriteSafe({ value: { $exists: true } })).toBe(true);
        expect(isFilterRewriteSafe({ value: { $exists: 1 } })).toBe(false);
        expect(isFilterRewriteSafe({ value: { $options: 'i' } })).toBe(true);
        expect(isFilterRewriteSafe({ value: { $options: 1 } })).toBe(false);
        expect(isFilterRewriteSafe({ value: { $size: 0 } })).toBe(true);
        expect(isFilterRewriteSafe({ value: { $size: -1 } })).toBe(false);
        expect(isFilterRewriteSafe({ value: { $size: 1.5 } })).toBe(false);
        expect(isFilterRewriteSafe({ value: { $mod: [2, 0] } })).toBe(true);
        expect(isFilterRewriteSafe({ value: { $mod: [2] } })).toBe(false);
        expect(isFilterRewriteSafe({ value: { $mod: [2, '0'] } })).toBe(false);
        expect(isFilterRewriteSafe({ value: { $mod: 2 } })).toBe(false);
    });

    it('validates not, elemMatch, all, empty, and mixed field conditions', () =>
    {
        expect(isFilterRewriteSafe({ value: { $not: /^blocked/ } })).toBe(true);
        expect(isFilterRewriteSafe({
            value: {
                $not: {
                    $gt: 1,
                },
            },
        })).toBe(true);
        expect(isFilterRewriteSafe({ value: { $not: { literal: 1 } } })).toBe(false);

        expect(isFilterRewriteSafe({
            values: {
                $elemMatch: {
                    $gt: 1,
                },
            },
        })).toBe(true);
        expect(isFilterRewriteSafe({ values: { $elemMatch: {} } })).toBe(true);
        expect(isFilterRewriteSafe({ values: { $elemMatch: null } })).toBe(false);

        expect(isFilterRewriteSafe({
            values: {
                $all: [
                    1,
                    {
                        $elemMatch: {
                            score: { $gte: 2 },
                        },
                    },
                ],
            },
        })).toBe(true);
        expect(isFilterRewriteSafe({ values: { $all: 'invalid' } })).toBe(false);
        expect(isFilterRewriteSafe({
            values: {
                $all: [
                    {
                        $elemMatch: null,
                    },
                ],
            },
        })).toBe(false);
        expect(isFilterRewriteSafe({
            values: {
                $bitsAllSet: 1,
            },
        })).toBe(false);

        expect(isFilterRewriteSafe({ value: {} })).toBe(true);
        expect(isFilterRewriteSafe({
            value: {
                $gt: 1,
                literal: 2,
            },
        })).toBe(false);
        expect(isFilterRewriteSafe({ $nor: [{ value: 1 }] })).toBe(false);
    });

    it('reports malformed and document-scoped analyzer forms precisely', () =>
    {
        const nonDocument = analyzeFilter(null);
        expect(nonDocument.malformed).toBe(true);
        expect(nonDocument.dependencies.local).toEqual(new Set(['*']));

        const malformedElemMatch = analyzeFilter({
            items: {
                $elemMatch: null,
            },
        });
        expect(malformedElemMatch.malformed).toBe(true);

        const emptyCondition = analyzeFilter({ value: {} });
        expect(emptyCondition.malformed).toBe(false);
        expect(emptyCondition.unknown).toBe(false);

        const mixedCondition = analyzeFilter({
            value: {
                $gt: 1,
                literal: 2,
            },
        });
        expect(mixedCondition.malformed).toBe(true);

        const malformedAll = analyzeFilter({
            items: {
                $all: 'invalid',
            },
        });
        expect(malformedAll.malformed).toBe(true);

        const nestedAll = analyzeFilter({
            items: {
                $all: [
                    {
                        $elemMatch: {
                            score: { $gt: 1 },
                        },
                    },
                    2,
                ],
            },
        });
        expect(nestedAll.dependencies.local).toEqual(new Set(['items']));
        expect(nestedAll.dependencies.element).toEqual(new Set(['score']));

        const malformedLogical = analyzeFilter({ $and: [null] });
        expect(malformedLogical.malformed).toBe(true);

        const unsupportedFieldOperator = analyzeFilter({
            value: {
                $futureComparison: 1,
            },
        });
        expect(unsupportedFieldOperator.unknown).toBe(true);
        expect(unsupportedFieldOperator.malformed).toBe(false);

        const comment = analyzeFilter({ $comment: 'trace' });
        expect(comment.dependencies.local).toEqual(new Set());
        expect(comment.unknown).toBe(false);

        const where = analyzeFilter({ $where: 'return true' });
        expect(where.dependencies.local).toEqual(new Set(['*']));
        expect(where.determinism).toBe('unknown');
        expect(where.errors).toBe('may-error');

        const valueElemMatch = analyzeFilter({
            values: {
                $elemMatch: {
                    $gt: 1,
                },
            },
        });
        expect(valueElemMatch.unknown).toBe(false);
        expect(valueElemMatch.dependencies.local).toEqual(new Set(['values']));
    });
});

describe('path and projection edge behavior', () =>
{
    it('normalizes dollar-prefixed paths and rejects malformed runtime inputs', () =>
    {
        expect(exactPath('$profile.name')).toEqual({
            kind: 'exact',
            path: 'profile.name',
        });
        expect(exactPath('$$variable')).toEqual({ kind: 'unknown' });
        expect(exactPath('')).toEqual({ kind: 'unknown' });
        expect(exactPath('?')).toEqual({ kind: 'unknown' });
        expect(exactPath('profile..name')).toEqual({ kind: 'unknown' });
        expect(exactPath(42 as unknown as string)).toEqual({ kind: 'unknown' });
        expect(removedPath('')).toEqual({ kind: 'unknown' });
        expect(relatePaths('', 'profile')).toBe('unknown');
        expect(relatePaths('profile', '')).toBe('unknown');
    });

    it('covers wildcard removals, overlap, and iterable coverage decisions', () =>
    {
        expect(relatePathEffects(removedPath('profile'), '*')).toBe('removed');
        expect(pathsOverlap('profile', 'profile.name')).toBe(true);
        expect(pathsOverlap('profile', 'settings')).toBe(false);
        expect(pathsOverlap('?', 'profile')).toBe(false);
        expect(anyPathCovers(['settings', 'profile'], 'profile.name')).toBe(true);
        expect(anyPathCovers(['settings', 'account'], 'profile.name')).toBe(false);
        expect(pathCovers('$profile', 'profile.name')).toBe(true);
    });

    it('classifies computed ids, invalid specs, and add-field ids', () =>
    {
        const computedId = analyzeProjection({ _id: '$sourceId' });
        expect(computedId.id).toBe('computed');
        expect(computedId.mode).toBe('inclusion');
        expect(computedId.computedPaths).toEqual(new Set(['_id']));

        const addFieldId = analyzeProjection({ _id: '$sourceId' }, 'add-fields');
        expect(addFieldId.id).toBe('computed');
        expect(addFieldId.mode).toBe('add-fields');
        expect(addFieldId.computedPaths).toEqual(new Set(['_id']));

        const invalid = analyzeProjection(null);
        expect(invalid.mode).toBe('unknown');
        expect(invalid.id).toBe('unknown');
        expect(projectionVisibility(invalid, '_id')).toBe('unknown');

        const empty = analyzeProjection({});
        expect(empty.mode).toBe('unknown');
        expect(empty.unknown).toBe(true);
    });

    it('distinguishes partial and unknown visibility from nested effects', () =>
    {
        const exclusion = analyzeProjection({
            'profile.secret': 0,
        });
        expect(projectionVisibility(exclusion, 'profile')).toBe('partial');

        const wildcardExclusion = analyzeProjection({ '*': 0 });
        expect(projectionVisibility(wildcardExclusion, 'profile')).toBe('unknown');

        const addFields = analyzeProjection({
            profile: {
                name: '$name',
            },
        }, 'add-fields');
        expect(projectionVisibility(addFields, 'profile.name')).toBe('unknown');

        const computed = analyzeProjection({
            profile: {
                name: '$name',
            },
        });
        expect(projectionVisibility(computed, 'profile.name')).toBe('unknown');
    });
});

describe('stage analyzer malformed and optional forms', () =>
{
    it('joins compound lattice effects through every conservative branch', () =>
    {
        expect(joinCardinality('filters-and-expands', 'filters')).toBe(
            'filters-and-expands',
        );
        expect(joinCardinality('filters-and-expands', 'expands')).toBe(
            'filters-and-expands',
        );
        expect(joinOrder('unknown', 'preserves')).toBe('unknown');
        expect(joinOrder('destroys', 'reorders')).toBe('destroys');
        expect(joinProvenance('unknown', 'local')).toBe('unknown');
    });

    it('accepts null-prototype stages as plain stage documents', () =>
    {
        const stage = Object.assign(Object.create(null) as Record<string, unknown>, {
            $match: {
                active: true,
            },
        });
        const summary = analyzeStage(stage);

        expect(summary.operator).toBe('$match');
        expect(summary.cardinality).toBe('filters');
        expect(summary.malformed).toBe(false);
    });

    it('returns conservative top for malformed stage-specific operands', () =>
    {
        const malformedStages = [
            { $set: null },
            { $unset: [] },
            { $unset: ['valid', 1] },
            { $sort: {} },
            { $sample: { size: -1 } },
            { $unwind: { path: 'items' } },
            { $unwind: 1 },
            { $group: { total: { $sum: '$value' } } },
            { $count: 'nested.total' },
            { $replaceRoot: {} },
            { $lookup: { as: '' } },
            { $lookup: { as: 'joined', localField: 1 } },
            { $lookup: { as: 'joined', foreignField: 1 } },
            { $lookup: { as: 'joined', let: null } },
            { $lookup: { as: 'joined', pipeline: {} } },
            {
                $graphLookup: {
                    as: 'graph',
                    connectFromField: 'from',
                    connectToField: 'to',
                },
            },
            {
                $graphLookup: {
                    as: 'graph',
                    connectFromField: 'from',
                    connectToField: 'to',
                    startWith: '$start',
                    depthField: 1,
                },
            },
            { $facet: null },
            { $facet: { invalid: {} } },
            { $unionWith: 1 },
            { $unionWith: { coll: 'archive', pipeline: {} } },
            { $densify: { field: 'time' } },
            {
                $densify: {
                    field: 'time',
                    range: {},
                    partitionByFields: ['valid', 1],
                },
            },
            { $documents: {} },
            { $bucket: {} },
            { $bucket: { groupBy: '$score', output: null } },
            { $setWindowFields: null },
            { $setWindowFields: { sortBy: null } },
            { $setWindowFields: { output: null } },
            { $fill: null },
            { $fill: { output: {}, partitionByFields: ['valid', 1] } },
            { $fill: { output: {}, sortBy: null } },
        ];

        for (const stage of malformedStages)
        {
            const summary = analyzeStage(stage);
            expect(summary.malformed).toBe(true);
            expect(summary.unknown).toBe(true);
            expect(summary.dependencies.local).toEqual(new Set(['*']));
        }
    });

    it('models valid documents, buckets, windows, fills, and sort-by-count stages', () =>
    {
        const documents = analyzeStage({
            $documents: [
                {
                    copied: '$source',
                },
            ],
        });
        expect(documents.dependencies.local).toEqual(new Set(['source']));
        expect(documents.cardinality).toBe('replaces');
        expect(documents.provenance).toBe('generated');

        for (const operator of ['$bucket', '$bucketAuto'] as const)
        {
            const withoutOutput = analyzeStage({
                [operator]: {
                    groupBy: '$score',
                },
            });
            expect(withoutOutput.dependencies.local).toEqual(new Set(['score']));
            expect(withoutOutput.cardinality).toBe('collapses');

            const withOutput = analyzeStage({
                [operator]: {
                    groupBy: '$score',
                    output: {
                        total: {
                            $sum: '$amount',
                        },
                    },
                },
            });
            expect(withOutput.dependencies.local).toEqual(new Set([
                'score',
                'amount',
            ]));
            expect(withOutput.writes).toEqual(new Set(['_id', 'total']));
        }

        const window = analyzeStage({
            $setWindowFields: {},
        });
        expect(window.order).toBe('preserves');
        expect(window.writes).toEqual(new Set());

        const windowWithPartition = analyzeStage({
            $setWindowFields: {
                partitionBy: '$account',
            },
        });
        expect(windowWithPartition.dependencies.local).toEqual(new Set(['account']));

        const fill = analyzeStage({
            $fill: {
                partitionBy: '$account',
                output: {
                    score: {
                        method: 'linear',
                    },
                },
            },
        });
        expect(fill.dependencies.local).toEqual(new Set(['account']));
        expect(fill.writes).toEqual(new Set(['score']));

        const fillWithoutOptions = analyzeStage({
            $fill: {
                output: {},
            },
        });
        expect(fillWithoutOptions.malformed).toBe(false);

        const sortByCount = analyzeStage({ $sortByCount: '$category' });
        expect(sortByCount.dependencies.local).toEqual(new Set(['category']));
        expect(sortByCount.writes).toEqual(new Set(['_id', 'count']));
        expect(sortByCount.cardinality).toBe('collapses');
    });

    it('resolves lookup let bindings from literals, documents, and parent variables', () =>
    {
        const variables = new Map([
            ['outerPath', { scope: 'local' as const, path: 'outer' }],
            ['outerWhole', { scope: 'local' as const, wholeDocument: true }],
            ['outerBare', { scope: 'local' as const }],
        ]);
        const lookup = analyzeStage({
            $lookup: {
                as: 'joined',
                let: {
                    literal: 1,
                    direct: '$source',
                    root: '$$ROOT',
                    rootPath: '$$ROOT.profile',
                    current: '$$CURRENT',
                    inherited: '$$outerPath',
                    inheritedChild: '$$outerPath.child',
                    inheritedWholeChild: '$$outerWhole.child',
                    inheritedBare: '$$outerBare',
                    inheritedBareChild: '$$outerBare.child',
                    missingParent: '$$missing.child',
                },
                pipeline: [
                    {
                        $project: {
                            literalLeaf: '$$literal.leaf',
                            directWhole: '$$direct',
                            directLeaf: '$$direct.leaf',
                            rootWhole: '$$root',
                            rootLeaf: '$$root.leaf',
                            inheritedWhole: '$$inherited',
                            inheritedLeaf: '$$inherited.leaf',
                            inheritedWholeLeaf: '$$inheritedWholeChild.leaf',
                            inheritedBareLeaf: '$$inheritedBare.leaf',
                            unbound: '$$notDeclared.leaf',
                        },
                    },
                ],
            },
        }, 0, {
            variables,
        });

        expect(lookup.children).toHaveLength(1);
        expect(lookup.children[0]!.outerDependencies).toEqual(new Set([
            '*',
            'source',
            'source.leaf',
            'outer',
            'outer.leaf',
            'child.leaf',
            'leaf',
        ]));
        expect(lookup.dependencies.local.has('*')).toBe(true);
        expect(lookup.dependencies.local.has('source.leaf')).toBe(true);
    });

    it('returns conservative pipeline semantics for a non-pipeline input', () =>
    {
        const summary = analyzePipeline(null);
        expect(summary.stages).toEqual([]);
        expect(summary.dependencies.local).toEqual(new Set(['*']));
        expect(summary.malformed).toBe(true);
        expect(summary.observable.unknown).toBe(true);
    });
});

describe('movement proof edge behavior', () =>
{
    it('rewrites descendant aliases and accepts null-prototype match stages', () =>
    {
        const matchStage = Object.assign(
            Object.create(null) as Record<string, unknown>,
            {
                $match: {
                    'alias.child': 1,
                },
            },
        );
        expect(proveMatchPushdownAcrossStage(
            { $addFields: { alias: '$source' } },
            matchStage,
        )).toEqual({
            matchStage: {
                $match: {
                    'source.child': 1,
                },
            },
        });
    });

    it('rewrites expression aliases while preserving literals, builtins, and BSON values', () =>
    {
        const date = new Date('2026-01-01T00:00:00.000Z');
        class BsonValue {}
        const bsonValue = new BsonValue();
        expect(proveMatchPushdownAcrossStage(
            { $addFields: { alias: '$source' } },
            {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ['$alias', 'literal'] },
                            { $eq: ['$untouched', 123] },
                            { $eq: ['$$ROOT.alias', '$$NOW'] },
                            { $eq: ['$$CURRENT.untouched', date] },
                            { $eq: [{ $literal: '$alias' }, '$alias'] },
                            { $eq: ['$alias', bsonValue] },
                        ],
                    },
                },
            },
        )).toEqual({
            matchStage: {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ['$source', 'literal'] },
                            { $eq: ['$untouched', 123] },
                            { $eq: ['$$ROOT.source', '$$NOW'] },
                            { $eq: ['$$CURRENT.untouched', date] },
                            { $eq: [{ $literal: '$alias' }, '$source'] },
                            { $eq: ['$source', bsonValue] },
                        ],
                    },
                },
            },
        });

        expect(proveMatchPushdownAcrossStage(
            { $addFields: { alias: '$alias' } },
            {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ['$alias', 1] },
                            { $eq: ['$$ROOT.alias', 1] },
                        ],
                    },
                },
            },
        )).toEqual({
            matchStage: {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ['$alias', 1] },
                            { $eq: ['$$ROOT.alias', 1] },
                        ],
                    },
                },
            },
        });
    });

    it('declines syntax-aware rewrites containing getField', () =>
    {
        expect(proveMatchPushdownAcrossStage(
            { $addFields: { alias: '$source' } },
            {
                $match: {
                    $expr: {
                        $eq: [
                            {
                                $getField: {
                                    field: 'alias',
                                    input: '$$CURRENT',
                                },
                            },
                            1,
                        ],
                    },
                },
            },
        )).toBeNull();

        expect(proveMatchPushdownAcrossStage(
            { $addFields: { alias: '$source' } },
            {
                $match: {
                    $and: [
                        {
                            $expr: {
                                $eq: [
                                    {
                                        $getField: {
                                            field: 'alias',
                                            input: '$$CURRENT',
                                        },
                                    },
                                    1,
                                ],
                            },
                        },
                    ],
                },
            },
        )).toBeNull();
    });

    it('rewrites document literals and all/elemMatch filters without changing element keys', () =>
    {
        expect(proveMatchPushdownAcrossStage(
            { $project: { _id: 0, alias: '$source' } },
            {
                $match: {
                    alias: {
                        nested: 1,
                    },
                    $comment: 'keep',
                },
            },
        )).toEqual({
            matchStage: {
                $match: {
                    source: {
                        nested: 1,
                    },
                    $comment: 'keep',
                },
            },
        });

        expect(proveMatchPushdownAcrossStage(
            { $project: { _id: 0, alias: '$source' } },
            {
                $match: {
                    alias: {
                        $all: [
                            1,
                            {
                                $elemMatch: {
                                    $gt: 1,
                                },
                            },
                        ],
                    },
                },
            },
        )).toEqual({
            matchStage: {
                $match: {
                    source: {
                        $all: [
                            1,
                            {
                                $elemMatch: {
                                    $gt: 1,
                                },
                            },
                        ],
                    },
                },
            },
        });

        expect(proveMatchPushdownAcrossStage(
            { $project: { _id: 0, alias: '$source' } },
            {
                $match: {
                    alias: {
                        $not: {
                            $gt: 1,
                        },
                    },
                },
            },
        )).toEqual({
            matchStage: {
                $match: {
                    source: {
                        $not: {
                            $gt: 1,
                        },
                    },
                },
            },
        });
    });

    it('keeps unsupported passive stages fixed and proves direct priority limit swaps', () =>
    {
        expect(proveMatchPushdownAcrossStage(
            { $setWindowFields: {} },
            { $match: { active: true } },
        )).toBeNull();
        expect(proveLimitAdvanceAcrossStage(
            { $setWindowFields: {} },
            { $limit: 1 },
        )).toBe(false);
        expect(provePrioritySwap(
            { $set: { stable: true } },
            { $limit: 1 },
        )).toEqual([
            { $limit: 1 },
            { $set: { stable: true } },
        ]);
        expect(provePrioritySwap(
            { $unwind: '$items' },
            { $match: { category: 'electronics' } },
        )).toEqual([
            { $match: { category: 'electronics' } },
            { $unwind: '$items' },
        ]);
        expect(provePrioritySwap(
            { $unwind: '$items' },
            { $match: { category: 'electronics', 'items.qty': 5 } },
        )).toBeNull();
    });
});

describe('projection proof edge behavior', () =>
{
    it('rejects non-stages, null-prototype ambiguity, and invalid dependency paths', () =>
    {
        expect(proveAdjacentAddFieldMerge(null, { $set: { value: 1 } })).toBeNull();

        const nullPrototype = Object.assign(
            Object.create(null) as Record<string, unknown>,
            {
                $set: {
                    value: 1,
                },
            },
        );
        expect(proveAdjacentAddFieldMerge(
            nullPrototype,
            { $set: { other: 2 } },
        )).toEqual({
            mergedStage: {
                $set: {
                    value: 1,
                    other: 2,
                },
            },
        });

        expect(proveAdjacentAddFieldMerge(
            { $set: { value: '$invalid..path' } },
            { $set: { other: 2 } },
        )).toBeNull();
    });

    it('represents an inclusion reduced to only the default id explicitly', () =>
    {
        expect(proveAdjacentProjectMerge(
            { $project: { only: 1 } },
            { $project: { only: 0 } },
        )).toEqual({
            mergedStage: {
                $project: {
                    _id: 1,
                },
            },
        });
    });

    it('prunes safe arrays, literal documents, and ordinary nested documents', () =>
    {
        const assignments = [
            ['array', ['$source', 1]],
            ['literal', { $literal: { $operatorLookingKey: '$notARead' } }],
            ['document', { nested: '$source' }],
        ] as const;

        for (const [field, expression] of assignments)
        {
            expect(proveUnusedFieldPruning(
                { $set: { [field]: expression } },
                { $unset: field },
            )).toEqual({
                replacementStage: null,
                removedFields: [field],
            });
        }
    });

    it('keeps syntactically harmless unbound-variable assignments observable', () =>
    {
        expect(proveUnusedFieldPruning(
            {
                $set: {
                    dead: {
                        nested: '$$unbound.value',
                    },
                },
            },
            { $unset: 'dead' },
        )).toBeNull();
    });

    it('prunes dotted-safe top-level writes hidden by inclusion projects', () =>
    {
        expect(proveUnusedFieldPruning(
            {
                $addFields: {
                    'profile.name': 'Ada',
                    dead: 1,
                },
            },
            { $project: { name: 1 } },
        )).toEqual({
            replacementStage: {
                $addFields: {
                    'profile.name': 'Ada',
                },
            },
            removedFields: ['dead'],
        });
    });
});

describe('successful-result movement proofs', () =>
{
    it('discards an exact path only through unset or a hiding project', () =>
    {
        expect(isExactPathDiscardedByFollower('orders', { $unset: 'orders' })).toBe(
            true,
        );
        expect(isExactPathDiscardedByFollower('orders', { $unset: 'other' })).toBe(
            false,
        );
        expect(isExactPathDiscardedByFollower('orders', { $limit: 1 })).toBe(false);
        expect(isExactPathDiscardedByFollower(
            'orders',
            { $project: { name: 1 } },
        )).toBe(true);
        expect(isExactPathDiscardedByFollower(
            'orders',
            { $project: { orders: 0 } },
        )).toBe(true);
        expect(isExactPathDiscardedByFollower(
            'orders',
            { $project: { orders: 1 } },
        )).toBe(false);
    });

    it('eliminates only simple lookups whose alias is discarded next', () =>
    {
        const lookup = {
            $lookup: {
                from: 'orders',
                localField: 'customerId',
                foreignField: 'customerId',
                as: 'orders',
            },
        };

        expect(proveRedundantLookupElimination(lookup, { $project: { name: 1 } }))
            .toBe(true);
        expect(proveRedundantLookupElimination(lookup, { $unset: 'orders' }))
            .toBe(true);
        expect(proveRedundantLookupElimination(null, { $project: { name: 1 } }))
            .toBe(false);
        expect(proveRedundantLookupElimination(
            {
                $lookup: {
                    from: 'orders',
                    pipeline: [],
                    as: 'orders',
                },
            },
            { $project: { name: 1 } },
        )).toBe(false);
        expect(proveRedundantLookupElimination(
            lookup,
            { $project: { name: 1, orders: 1 } },
        )).toBe(false);
    });

    it('advances a simple project before sort only when every sort key stays visible', () =>
    {
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { age: 1 } },
            { $project: { name: 1, age: 1 } },
        )).toBe(true);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { age: -1, _id: 1 } },
            { $project: { age: 1 } },
        )).toBe(true);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { age: 1 } },
            { $project: { name: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(null, { $project: { age: 1 } }))
            .toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $limit: 1 },
            { $project: { age: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: 'age' },
            { $project: { age: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: {} },
            { $project: { age: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { age: 'desc' } },
            { $project: { age: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { age: 1 }, $limit: 1 },
            { $project: { age: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { age: 1 } },
            { $project: { age: { $add: ['$age', 1] } } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { '$invalid': 1 } },
            { $project: { name: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { '': 1 } },
            { $project: { name: 1 } },
        )).toBe(false);
        expect(proveSimpleProjectAdvanceAcrossSort(
            { $sort: { 'a..b': 1 } },
            { $project: { name: 1 } },
        )).toBe(false);
    });

    it('defers safe addFields past a disjoint sort and rejects overlapping writes', () =>
    {
        expect(proveAddFieldDeferralAcrossSort(
            { $addFields: { label: '$name' } },
            { $sort: { score: -1 } },
        )).toBe(true);
        expect(proveAddFieldDeferralAcrossSort(
            { $set: { label: '$score' } },
            { $sort: { score: -1 } },
        )).toBe(true);
        expect(proveAddFieldDeferralAcrossSort(
            { $addFields: { score: 1 } },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveAddFieldDeferralAcrossSort(
            { $addFields: { profile: { name: 'Ada' } } },
            { $sort: { 'profile.age': 1 } },
        )).toBe(false);
        expect(proveAddFieldDeferralAcrossSort(
            { $addFields: { computed: { $add: ['$source', 1] } } },
            { $sort: { score: -1 } },
        )).toBe(true);
        expect(proveAddFieldDeferralAcrossSort(
            { $addFields: { random: { $rand: {} } } },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveAddFieldDeferralAcrossSort(
            { $project: { name: 1 } },
            { $sort: { score: -1 } },
        )).toBe(false);
        expect(proveAddFieldDeferralAcrossSort(
            { $addFields: { label: '$name' } },
            { $sort: {} },
        )).toBe(false);
    });

    it('prunes through a transparent suffix and rejects an empty or observing one', () =>
    {
        expect(proveUnusedFieldPruningThroughSuffix(
            { $addFields: { dead: 1 } },
            [],
        )).toBeNull();
        expect(proveUnusedFieldPruningThroughSuffix(
            { $addFields: { dead: { $rand: {} } } },
            [{ $unset: 'dead' }],
        )).toBeNull();
        expect(proveUnusedFieldPruningThroughSuffix(
            { $addFields: { dead: 1 } },
            [{ $sort: { score: -1 } }, { $unset: 'dead' }],
        )).toEqual({
            replacementStage: null,
            removedFields: ['dead'],
        });
        expect(proveUnusedFieldPruningThroughSuffix(
            { $addFields: { dead: 1 } },
            [{ $match: { dead: 1 } }, { $unset: 'dead' }],
        )).toBeNull();
        expect(proveUnusedFieldPruningThroughSuffix(
            { $addFields: { dead: 1 } },
            [{ $project: { secret: 0 } }, { $unset: 'dead' }],
        )).toBeNull();
        expect(proveUnusedFieldPruningThroughSuffix(
            { $addFields: { dead: 1 } },
            [{ $limit: '1' }, { $unset: 'dead' }],
        )).toBeNull();
    });
});
