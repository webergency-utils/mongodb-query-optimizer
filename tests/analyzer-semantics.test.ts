import { describe, expect, it } from 'vitest';
import {
    exactPath,
    pathCovers,
    relatePathEffects,
    relatePaths,
    removedPath,
    unknownPath,
    wildcardPath,
} from '../src/analyzer/paths.js';
import {
    analyzeProjection,
    projectionVisibility,
} from '../src/analyzer/projections.js';
import {
    analyzePipeline,
    analyzeStage,
    joinCardinality,
    joinDeterminism,
    joinErrors,
    joinOrder,
    joinProvenance,
} from '../src/analyzer/semantics.js';
import { analyzeExpression } from '../src/analyzer/expressions.js';
import { analyzeFilter } from '../src/analyzer/filters.js';
import { getStageInfo } from '../src/index.js';

describe('analyzer path algebra', () =>
{
    it('distinguishes directional and conservative path relations', () =>
    {
        expect(relatePaths('profile.name', 'profile.name')).toBe('exact');
        expect(relatePaths('profile', 'profile.name')).toBe('ancestor');
        expect(relatePaths('profile.name', 'profile')).toBe('descendant');
        expect(relatePaths('profile.name', 'settings.name')).toBe('disjoint');
        expect(relatePaths('*', 'profile.name')).toBe('wildcard');
        expect(relatePaths('?', 'profile.name')).toBe('unknown');

        expect(pathCovers('profile', 'profile.name')).toBe(true);
        expect(pathCovers('profile.name', 'profile')).toBe(false);

        expect(relatePathEffects(exactPath('profile'), 'profile.name')).toBe('ancestor');
        expect(relatePathEffects(wildcardPath(), 'profile.name')).toBe('wildcard');
        expect(relatePathEffects(removedPath('profile'), 'profile.name')).toBe('removed');
        expect(relatePathEffects(unknownPath(), 'profile.name')).toBe('unknown');
    });
});

describe('projection semantics', () =>
{
    it('classifies _id-only and computed projection values without exposing omissions', () =>
    {
        const onlyId = analyzeProjection({ _id: 1 });
        expect(onlyId.mode).toBe('inclusion');
        expect(onlyId.id).toBe('included');
        expect(onlyId.shieldsOmittedFields).toBe(true);
        expect(projectionVisibility(onlyId, '_id')).toBe('visible');
        expect(projectionVisibility(onlyId, 'name')).toBe('hidden');

        const withoutId = analyzeProjection({ _id: 0 });
        expect(withoutId.mode).toBe('exclusion');
        expect(withoutId.id).toBe('excluded');
        expect(projectionVisibility(withoutId, '_id')).toBe('removed');
        expect(projectionVisibility(withoutId, 'name')).toBe('visible');

        for (const value of [42, ['$name'], {}])
        {
            const summary = analyzeProjection({ value });
            expect(summary.mode).toBe('inclusion');
            expect(summary.computedPaths).toEqual(new Set(['value']));
            expect(summary.shieldsOmittedFields).toBe(true);
        }
    });

    it('models mixed/add-fields modes, partial parents, and path collisions', () =>
    {
        const mixed = analyzeProjection({ visible: 1, secret: 0 });
        expect(mixed.mode).toBe('mixed');
        expect(projectionVisibility(mixed, 'visible')).toBe('unknown');

        const addFields = analyzeProjection(
            { total: { $add: ['$subtotal', '$tax'] } },
            'add-fields',
        );
        expect(addFields.mode).toBe('add-fields');
        expect(addFields.shieldsOmittedFields).toBe(false);
        expect(projectionVisibility(addFields, 'unmentioned')).toBe('visible');

        const nested = analyzeProjection({
            'profile.name': 1,
            settings: 1,
        });
        expect(projectionVisibility(nested, 'profile.name')).toBe('visible');
        expect(projectionVisibility(nested, 'profile')).toBe('partial');
        expect(projectionVisibility(nested, 'profile.age')).toBe('hidden');

        const colliding = analyzeProjection({
            profile: 1,
            'profile.name': 1,
        });
        expect(colliding.hasPathCollisions).toBe(true);
        expect(colliding.collisions).toEqual([
            {
                left: 'profile',
                right: 'profile.name',
                relation: 'ancestor',
            },
        ]);
    });
});

describe('conservative semantic lattices', () =>
{
    it('joins effects deterministically, commutatively, and conservatively', () =>
    {
        expect(joinCardinality('preserves', 'filters')).toBe('filters');
        expect(joinCardinality('filters', 'expands')).toBe('filters-and-expands');
        expect(joinCardinality('expands', 'filters')).toBe('filters-and-expands');
        expect(joinCardinality('filters', 'filters')).toBe('filters');
        expect(joinCardinality('filters', 'unknown')).toBe('unknown');

        expect(joinOrder('preserves', 'establishes')).toBe('establishes');
        expect(joinOrder('establishes', 'reorders')).toBe('unknown');
        expect(joinProvenance('local', 'foreign')).toBe('mixed');
        expect(joinProvenance('local', 'local-and-foreign')).toBe('local-and-foreign');
        expect(joinDeterminism('deterministic', 'volatile')).toBe('volatile');
        expect(joinDeterminism('volatile', 'unknown')).toBe('unknown');
        expect(joinErrors('none-known', 'may-error')).toBe('may-error');
        expect(joinErrors('may-error', 'unknown')).toBe('unknown');
    });
});

describe('expression semantics', () =>
{
    it('keeps literals, field references, and plain document construction error-free', () =>
    {
        const summary = analyzeExpression({
            literal: 1,
            reference: '$field',
            nested: {
                values: [
                    '$other',
                    { $literal: { $operatorLookingKey: '$notARead' } },
                ],
            },
        });

        expect(summary.dependencies.local).toEqual(new Set(['field', 'other']));
        expect(summary.determinism).toBe('deterministic');
        expect(summary.errors).toBe('none-known');
        expect(summary.unknown).toBe(false);
    });

    it('records field, document-variable, and getField dependencies in scope', () =>
    {
        const variables = new Map([
            ['order', { scope: 'local' as const, path: 'orders' }],
        ]);
        const summary = analyzeExpression({
            direct: '$price',
            root: '$$ROOT.customer.id',
            current: '$$CURRENT.status',
            qualifiedVariable: '$$order.total',
            shorthandGetField: { $getField: 'sku' },
            objectGetField: {
                $getField: {
                    field: 'name',
                    input: '$profile',
                },
            },
            opaque: { $literal: '$notARead' },
        }, {
            documentScope: 'local',
            variables,
        });

        expect(summary.dependencies.local).toEqual(new Set([
            'price',
            'customer.id',
            'status',
            'orders.total',
            'sku',
            'profile',
            'profile.name',
        ]));
        expect(summary.dependencies.variables.get('order')).toEqual(new Set(['total']));
        expect(summary.dependencies.local.has('notARead')).toBe(false);
        expect(summary.determinism).toBe('deterministic');
        expect(summary.errors).toBe('may-error');
        expect(summary.unknown).toBe(false);
    });

    it('only proves validated input-total operator forms error-free', () =>
    {
        const comparisonOperators = [
            '$eq',
            '$ne',
            '$gt',
            '$gte',
            '$lt',
            '$lte',
            '$cmp',
        ];

        for (const operator of comparisonOperators)
        {
            expect(analyzeExpression({
                [operator]: ['$left', '$right'],
            }).errors).toBe('none-known');
            expect(analyzeExpression({
                [operator]: ['$only'],
            }).errors).toBe('may-error');
        }

        for (const expression of [
            { $and: [] },
            { $or: [true, { $eq: ['$left', '$right'] }] },
            { $not: ['$flag'] },
            { $ifNull: ['$optional', 'fallback'] },
            { $ifNull: ['$first', '$second', 'fallback'] },
        ])
        {
            expect(analyzeExpression(expression).errors).toBe('none-known');
        }

        for (const expression of [
            { $eq: '$value' },
            { $eq: ['$value', 1, 2] },
            { $and: true },
            { $or: {} },
            { $not: '$flag' },
            { $not: [] },
            { $not: [true, false] },
            { $ifNull: '$optional' },
            { $ifNull: [] },
            { $ifNull: ['$optional'] },
        ])
        {
            expect(analyzeExpression(expression).errors).toBe('may-error');
        }
    });

    it('marks type-sensitive and incompletely validated operators may-error', () =>
    {
        const expressions = [
            { $add: ['$value', 1] },
            { $multiply: ['$value', 2] },
            { $toString: '$value' },
            { $concat: ['$value', 'suffix'] },
            {
                $dateAdd: {
                    startDate: '$value',
                    unit: 'day',
                    amount: 1,
                },
            },
            { $arrayElemAt: ['$value', 0] },
            {
                $map: {
                    input: '$value',
                    in: '$$this',
                },
            },
            {
                $filter: {
                    input: '$value',
                    cond: true,
                },
            },
            {
                $reduce: {
                    input: '$value',
                    initialValue: 0,
                    in: '$$value',
                },
            },
            { $getField: 'value' },
            {
                $getField: {
                    field: '$dynamicField',
                    input: '$value',
                },
            },
        ];

        for (const expression of expressions)
        {
            expect(analyzeExpression(expression).errors).toBe('may-error');
        }
    });

    it('marks whole-document, volatile, erroring, and unknown expressions', () =>
    {
        const wholeDocument = analyzeExpression(
            ['$$ROOT', '$$CURRENT'],
            { documentScope: 'foreign' },
        );
        expect(wholeDocument.dependencies.foreign).toEqual(new Set(['*']));

        const random = analyzeExpression(
            { $rand: {} },
            { documentScope: 'local' },
        );
        expect(random.determinism).toBe('volatile');
        expect(random.errors).toBe('none-known');

        const userFunction = analyzeExpression({
            $function: {
                body: 'function (x) { return x; }',
                args: ['$score'],
                lang: 'js',
            },
        }, { documentScope: 'local' });
        expect(userFunction.dependencies.local).toEqual(new Set(['score']));
        expect(userFunction.determinism).toBe('volatile');
        expect(userFunction.errors).toBe('may-error');

        const userAccumulator = analyzeExpression({
            $accumulator: {
                init: 'function (seed) { return seed; }',
                initArgs: ['$seed'],
                accumulate: 'function (state, value) { return value; }',
                accumulateArgs: ['$value'],
                merge: 'function (left, right) { return left; }',
                lang: 'js',
            },
        }, { documentScope: 'local' });
        expect(userAccumulator.dependencies.local).toEqual(new Set([
            'seed',
            'value',
        ]));
        expect(userAccumulator.determinism).toBe('volatile');
        expect(userAccumulator.errors).toBe('may-error');

        const division = analyzeExpression(
            { $divide: ['$total', '$count'] },
            { documentScope: 'local' },
        );
        expect(division.dependencies.local).toEqual(new Set(['total', 'count']));
        expect(division.determinism).toBe('deterministic');
        expect(division.errors).toBe('may-error');

        const invalidRandWithDependency = analyzeExpression({
            $rand: {
                seed: '$seed',
            },
        });
        expect(invalidRandWithDependency.dependencies.local).toEqual(new Set(['seed']));
        expect(invalidRandWithDependency.determinism).toBe('volatile');
        expect(invalidRandWithDependency.errors).toBe('may-error');

        const invalidRandShape = analyzeExpression({ $rand: null });
        expect(invalidRandShape.determinism).toBe('volatile');
        expect(invalidRandShape.errors).toBe('may-error');

        const unsupported = analyzeExpression(
            { $unsupportedOperator: '$value' },
            { documentScope: 'local' },
        );
        expect(unsupported.dependencies.local).toEqual(new Set(['value', '*']));
        expect(unsupported.determinism).toBe('unknown');
        expect(unsupported.errors).toBe('unknown');
        expect(unsupported.unknown).toBe(true);
    });
});

describe('filter semantics', () =>
{
    it('uses expression scope for $expr and element scope for $elemMatch', () =>
    {
        const summary = analyzeFilter({
            $expr: {
                $gt: ['$score', '$$ROOT.minimum'],
            },
            items: {
                $elemMatch: {
                    price: { $gt: 10 },
                    $or: [
                        { sku: 'ABC' },
                        { qty: { $gte: 2 } },
                    ],
                },
            },
        });

        expect(summary.dependencies.local).toEqual(new Set([
            'score',
            'minimum',
            'items',
        ]));
        expect(summary.dependencies.element).toEqual(new Set([
            'price',
            'sku',
            'qty',
        ]));
        expect(summary.dependencies.local.has('items.price')).toBe(false);
        expect(summary.malformed).toBe(false);
        expect(summary.unknown).toBe(false);
    });
});

describe('stage and stream semantics', () =>
{
    it('models cardinality, order, and provenance independently', () =>
    {
        const cases = [
            {
                stage: { $match: { active: true } },
                cardinality: 'filters',
                order: 'preserves',
                provenance: 'local',
            },
            {
                stage: { $unwind: '$items' },
                cardinality: 'filters-and-expands',
                order: 'preserves',
                provenance: 'local',
            },
            {
                stage: { $group: { _id: '$category', total: { $sum: '$amount' } } },
                cardinality: 'collapses',
                order: 'destroys',
                provenance: 'generated',
            },
            {
                stage: { $count: 'total' },
                cardinality: 'collapses',
                order: 'destroys',
                provenance: 'generated',
            },
            {
                stage: { $sample: { size: 3 } },
                cardinality: 'filters',
                order: 'reorders',
                provenance: 'local',
            },
            {
                stage: { $unionWith: 'archive' },
                cardinality: 'expands',
                order: 'preserves',
                provenance: 'mixed',
            },
            {
                stage: {
                    $densify: {
                        field: 'timestamp',
                        range: { step: 1, unit: 'hour', bounds: 'full' },
                    },
                },
                cardinality: 'expands',
                order: 'unknown',
                provenance: 'mixed',
            },
            {
                stage: {
                    $lookup: {
                        from: 'orders',
                        localField: 'customerId',
                        foreignField: 'customerId',
                        as: 'orders',
                    },
                },
                cardinality: 'preserves',
                order: 'preserves',
                provenance: 'local-and-foreign',
            },
            {
                stage: {
                    $facet: {
                        active: [{ $match: { active: true } }],
                    },
                },
                cardinality: 'replaces',
                order: 'destroys',
                provenance: 'generated',
            },
        ] as const;

        for (const testCase of cases)
        {
            const summary = analyzeStage(testCase.stage);
            expect(summary.cardinality).toBe(testCase.cardinality);
            expect(summary.order).toBe(testCase.order);
            expect(summary.provenance).toBe(testCase.provenance);
        }

        const pipeline = analyzePipeline([
            { $match: { active: true } },
            { $sample: { size: 2 } },
        ]);
        expect(pipeline.cardinality).toBe('filters');
        expect(pipeline.order).toBe('reorders');
        expect(pipeline.determinism).toBe('volatile');
    });

    it('keeps graphLookup outer and foreign dependencies separate', () =>
    {
        const summary = analyzeStage({
            $graphLookup: {
                from: 'employees',
                startWith: '$managerId',
                connectFromField: 'managerId',
                connectToField: '_id',
                restrictSearchWithMatch: { active: true },
                as: 'reportingChain',
                depthField: 'depth',
            },
        });

        expect(summary.dependencies.local).toEqual(new Set(['managerId']));
        expect(summary.dependencies.foreign).toEqual(new Set([
            'managerId',
            '_id',
            'active',
        ]));
        expect(summary.writes).toEqual(new Set([
            'reportingChain',
            'reportingChain.depth',
        ]));
        expect(summary.writes.has('depth')).toBe(false);
    });

    it('composes lookup, facet, and union children in separately scoped summaries', () =>
    {
        const lookup = analyzeStage({
            $lookup: {
                from: 'orders',
                let: { customer: '$customer' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $eq: ['$customerId', '$$customer.id'],
                            },
                        },
                    },
                    {
                        $project: {
                            customerId: 1,
                            normalized: { $divide: ['$amount', '$rate'] },
                        },
                    },
                    { $sample: { size: 1 } },
                ],
                as: 'orders',
            },
        });

        expect(lookup.dependencies.local).toEqual(new Set([
            'customer',
            'customer.id',
        ]));
        expect(lookup.dependencies.foreign).toEqual(new Set([
            'customerId',
            '_id',
            'amount',
            'rate',
        ]));
        expect(lookup.children).toHaveLength(1);
        expect(lookup.children[0]!.scope).toBe('foreign');
        expect(lookup.children[0]!.outerDependencies).toEqual(new Set([
            'customer.id',
        ]));
        expect(lookup.children[0]!.foreignDependencies).toEqual(new Set([
            'customerId',
            '_id',
            'amount',
            'rate',
        ]));
        expect(lookup.cardinality).toBe('preserves');
        expect(lookup.observable.cardinality).toBe('filters');
        expect(lookup.observable.order).toBe('reorders');
        expect(lookup.determinism).toBe('volatile');
        expect(lookup.errors).toBe('may-error');

        const facet = analyzeStage({
            $facet: {
                totals: [
                    {
                        $group: {
                            _id: '$region',
                            total: { $sum: '$amount' },
                        },
                    },
                ],
                risky: [
                    {
                        $project: {
                            value: {
                                $function: {
                                    body: 'function (x) { return x; }',
                                    args: ['$score'],
                                    lang: 'js',
                                },
                            },
                        },
                    },
                ],
            },
        });
        expect(facet.children).toHaveLength(2);
        expect(facet.children[0]!.scope).toBe('local');
        expect(facet.children[0]!.outerDependencies).toEqual(new Set([
            'region',
            'amount',
        ]));
        expect(facet.dependencies.local).toEqual(new Set([
            'region',
            'amount',
            '_id',
            'score',
        ]));
        expect(facet.determinism).toBe('volatile');
        expect(facet.errors).toBe('may-error');

        const union = analyzeStage({
            $unionWith: {
                coll: 'archive',
                pipeline: [
                    { $match: { archived: false } },
                    { $sample: { size: 2 } },
                ],
            },
        });
        expect(union.children).toHaveLength(1);
        expect(union.children[0]!.scope).toBe('foreign');
        expect(union.children[0]!.foreignDependencies).toEqual(new Set(['archived']));
        expect(union.dependencies.local).toEqual(new Set());
        expect(union.dependencies.foreign).toEqual(new Set(['archived']));
        expect(union.cardinality).toBe('expands');
        expect(union.observable.order).toBe('reorders');
        expect(union.determinism).toBe('volatile');
    });

    it('returns conservative top for unknown and malformed stages', () =>
    {
        for (const stage of [
            null,
            { $match: null },
            { $match: {}, $limit: 1 },
            { $futureStage: { dynamic: '$value' } },
        ])
        {
            const summary = analyzeStage(stage);
            expect(summary.unknown).toBe(true);
            expect(summary.cardinality).toBe('unknown');
            expect(summary.order).toBe('unknown');
            expect(summary.provenance).toBe('unknown');
            expect(summary.determinism).toBe('unknown');
            expect(summary.errors).toBe('unknown');
            expect(summary.dependencies.local).toEqual(new Set(['*']));
            expect(summary.writes).toEqual(new Set(['?']));
            expect(summary.removes).toEqual(new Set(['?']));
        }
    });
});

describe('public stage adapter', () =>
{
    it('retains its ten-key shape, stage reference, types, and fresh mutable Sets', () =>
    {
        const stage = { $match: { active: true } };
        const first = getStageInfo(stage, 4);
        const second = getStageInfo(stage, 4);

        expect(Object.keys(first).sort()).toEqual([
            'altersCount',
            'index',
            'isDestructive',
            'isUnknown',
            'modifiedFields',
            'operator',
            'producedFields',
            'removedFields',
            'stage',
            'usedFields',
        ]);
        expect(first.stage).toBe(stage);
        expect(first.index).toBe(4);
        expect(first.operator).toBe('$match');
        expect(typeof first.isDestructive).toBe('boolean');
        expect(typeof first.altersCount).toBe('boolean');
        expect(typeof first.isUnknown).toBe('boolean');

        for (const key of [
            'usedFields',
            'producedFields',
            'modifiedFields',
            'removedFields',
        ] as const)
        {
            expect(first[key]).toBeInstanceOf(Set);
            expect(first[key]).not.toBe(second[key]);
            first[key].add('mutated');
            expect(second[key].has('mutated')).toBe(false);
        }

        expect('cardinality' in first).toBe(false);
        expect('children' in first).toBe(false);
    });

    it('adapts malformed semantics to the existing conservative public top', () =>
    {
        const malformedStage = { $match: null };
        const info = getStageInfo(malformedStage, 2);

        expect(info.stage).toBe(malformedStage);
        expect(info.operator).toBe('$match');
        expect(info.isUnknown).toBe(true);
        expect(info.isDestructive).toBe(true);
        expect(info.altersCount).toBe(true);
        expect(info.usedFields).toEqual(new Set(['*']));
        expect(info.producedFields).toEqual(new Set(['*']));
        expect(info.modifiedFields).toEqual(new Set(['*']));
        expect(info.removedFields).toEqual(new Set());
    });

    it('analyzes standard and complex stages accurately through getStageInfo', () =>
    {
        // $group
        const groupInfo = getStageInfo({
            $group: {
                _id: '$dept',
                total: { $sum: '$amount' },
                avgAge: { $avg: '$age' },
            },
        }, 0);
        expect(groupInfo.isDestructive).toBe(true);
        expect(groupInfo.altersCount).toBe(true);
        expect(groupInfo.producedFields.has('_id')).toBe(true);
        expect(groupInfo.producedFields.has('total')).toBe(true);
        expect(groupInfo.usedFields.has('dept')).toBe(true);
        expect(groupInfo.usedFields.has('amount')).toBe(true);

        // $lookup
        const lookupInfo = getStageInfo({
            $lookup: {
                from: 'orders',
                localField: 'customerId',
                foreignField: '_id',
                as: 'orders',
                let: { custId: '$customerId', tier: '$membership.tier' },
            },
        }, 1);
        expect(lookupInfo.producedFields.has('orders')).toBe(true);
        expect(lookupInfo.usedFields.has('customerId')).toBe(true);
        expect(lookupInfo.usedFields.has('membership.tier')).toBe(true);

        // $graphLookup
        const graphLookupInfo = getStageInfo({
            $graphLookup: {
                from: 'employees',
                startWith: '$reportsTo',
                connectFromField: 'reportsTo',
                connectToField: 'name',
                as: 'hierarchy',
                depthField: 'level',
                restrictSearchWithMatch: { active: true, dept: 'Eng' },
            },
        }, 2);
        expect(graphLookupInfo.producedFields.has('hierarchy')).toBe(true);
        expect(graphLookupInfo.producedFields.has('level')).toBe(true);
        expect(graphLookupInfo.usedFields.has('reportsTo')).toBe(true);
        expect(graphLookupInfo.usedFields.has('connectFromField')).toBe(false);
        expect(graphLookupInfo.usedFields.has('active')).toBe(true);
        expect(graphLookupInfo.usedFields.has('dept')).toBe(true);

        const graphLookupNoDepth = getStageInfo({
            $graphLookup: {
                from: 'employees',
                startWith: '$managerId',
                connectFromField: 'reportsTo',
                connectToField: 'name',
                as: 'chain',
            },
        }, 2);
        expect(graphLookupNoDepth.producedFields.has('chain')).toBe(true);
        expect(graphLookupNoDepth.usedFields.has('managerId')).toBe(true);

        // $project
        const projectInclusion = getStageInfo({
            $project: {
                name: 1,
                computed: { $concat: ['$first', ' ', '$last'] },
                simpleAlias: '$role',
            },
        }, 3);
        expect(projectInclusion.isDestructive).toBe(true);
        expect(projectInclusion.producedFields.has('name')).toBe(true);
        expect(projectInclusion.usedFields.has('first')).toBe(true);
        expect(projectInclusion.usedFields.has('role')).toBe(true);

        const projectExplicitId = getStageInfo({
            $project: {
                _id: 1,
                name: 1,
            },
        }, 3);
        expect(projectExplicitId.producedFields.has('_id')).toBe(true);
        expect(projectExplicitId.usedFields.has('_id')).toBe(true);

        const projectExclusion = getStageInfo({
            $project: {
                secret: 0,
                password: 0,
            },
        }, 4);
        expect(projectExclusion.isDestructive).toBe(false);
        expect(projectExclusion.removedFields.has('secret')).toBe(true);
        expect(projectExclusion.removedFields.has('password')).toBe(true);

        // $sort, $limit, $skip, $sample
        const sortInfo = getStageInfo({ $sort: { score: -1, date: 1 } }, 5);
        expect(sortInfo.usedFields.has('score')).toBe(true);
        expect(sortInfo.usedFields.has('date')).toBe(true);

        const limitInfo = getStageInfo({ $limit: 10 }, 6);
        expect(limitInfo.altersCount).toBe(true);

        const skipInfo = getStageInfo({ $skip: 5 }, 7);
        expect(skipInfo.altersCount).toBe(true);

        const sampleInfo = getStageInfo({ $sample: { size: 3 } }, 8);
        expect(sampleInfo.altersCount).toBe(true);

        // $addFields / $set / $unset
        const addFieldsInfo = getStageInfo({
            $addFields: {
                tax: { $multiply: ['$subtotal', 0.1] },
                sameField: '$sameField',
            },
        }, 9);
        expect(addFieldsInfo.producedFields.has('tax')).toBe(true);
        expect(addFieldsInfo.modifiedFields.has('tax')).toBe(true);
        expect(addFieldsInfo.modifiedFields.has('sameField')).toBe(false);

        const setInfo = getStageInfo({
            $set: {
                flag: true,
                alias: '$alias',
            },
        }, 9);
        expect(setInfo.producedFields.has('flag')).toBe(true);
        expect(setInfo.modifiedFields.has('alias')).toBe(false);

        const unsetInfo = getStageInfo({ $unset: ['temp', 'cache'] }, 10);
        expect(unsetInfo.removedFields.has('temp')).toBe(true);
        expect(unsetInfo.removedFields.has('cache')).toBe(true);

        const unsetSingle = getStageInfo({ $unset: 'tempOne' }, 11);
        expect(unsetSingle.removedFields.has('tempOne')).toBe(true);

        // $unwind
        const unwindStr = getStageInfo({ $unwind: '$tags' }, 12);
        expect(unwindStr.altersCount).toBe(true);
        expect(unwindStr.usedFields.has('tags')).toBe(true);

        const unwindObj = getStageInfo({
            $unwind: { path: '$items', includeArrayIndex: 'itemIndex' },
        }, 13);
        expect(unwindObj.producedFields.has('items')).toBe(true);
        expect(unwindObj.producedFields.has('itemIndex')).toBe(true);

        const unwindNoIndex = getStageInfo({
            $unwind: { path: '$items' },
        }, 13);
        expect(unwindNoIndex.producedFields.has('items')).toBe(true);

        // $count, $sortByCount
        const countInfo = getStageInfo({ $count: 'totalDocs' }, 14);
        expect(countInfo.isDestructive).toBe(true);
        expect(countInfo.producedFields.has('totalDocs')).toBe(true);

        const sortByCountInfo = getStageInfo({ $sortByCount: '$department' }, 15);
        expect(sortByCountInfo.isDestructive).toBe(true);
        expect(sortByCountInfo.usedFields.has('department')).toBe(true);
        expect(sortByCountInfo.producedFields.has('_id')).toBe(true);
        expect(sortByCountInfo.producedFields.has('count')).toBe(true);

        // $replaceRoot, $replaceWith
        const replaceRootInfo = getStageInfo({ $replaceRoot: { newRoot: '$nested' } }, 16);
        expect(replaceRootInfo.isDestructive).toBe(true);
        expect(replaceRootInfo.usedFields.has('nested')).toBe(true);

        const replaceWithInfo = getStageInfo({ $replaceWith: '$subdoc' }, 17);
        expect(replaceWithInfo.isDestructive).toBe(true);
        expect(replaceWithInfo.usedFields.has('subdoc')).toBe(true);

        // $facet
        const facetInfo = getStageInfo({
            $facet: {
                priceStats: [{ $group: { _id: null, avgPrice: { $avg: '$price' } } }],
                topItems: [{ $sort: { score: -1 } }, { $limit: 5 }],
            },
        }, 18);
        expect(facetInfo.producedFields.has('priceStats')).toBe(true);
        expect(facetInfo.producedFields.has('topItems')).toBe(true);
        expect(facetInfo.usedFields.has('price')).toBe(true);
        expect(facetInfo.usedFields.has('score')).toBe(true);

        // Remaining standard stages: $bucket, $bucketAuto, $setWindowFields, $densify, $fill, $documents, $unionWith
        const bucketInfo = getStageInfo({
            $bucket: {
                groupBy: '$price',
                boundaries: [0, 50, 100],
                output: { count: { $sum: 1 } },
            },
        }, 19);
        expect(bucketInfo.isDestructive).toBe(true);
        expect(bucketInfo.usedFields.has('price')).toBe(true);

        const bucketAutoInfo = getStageInfo({
            $bucketAuto: {
                groupBy: '$score',
                buckets: 5,
                output: { count: { $sum: 1 } },
            },
        }, 20);
        expect(bucketAutoInfo.isDestructive).toBe(true);
        expect(bucketAutoInfo.usedFields.has('score')).toBe(true);

        const setWindowFieldsInfo = getStageInfo({
            $setWindowFields: {
                partitionBy: '$state',
                sortBy: { date: 1 },
                output: {
                    cumulativeRevenue: {
                        $sum: '$revenue',
                        window: { documents: ['unbounded', 'current'] },
                    },
                },
            },
        }, 21);
        expect(setWindowFieldsInfo.producedFields.has('cumulativeRevenue')).toBe(true);
        expect(setWindowFieldsInfo.usedFields.has('state')).toBe(true);
        expect(setWindowFieldsInfo.usedFields.has('date')).toBe(true);

        const densifyInfo = getStageInfo({
            $densify: {
                field: 'timestamp',
                partitionByFields: ['sensorId'],
                range: { step: 1, unit: 'hour', bounds: 'full' },
            },
        }, 22);
        expect(densifyInfo.altersCount).toBe(true);
        expect(densifyInfo.usedFields.has('timestamp')).toBe(true);
        expect(densifyInfo.usedFields.has('sensorId')).toBe(true);

        const fillInfo = getStageInfo({
            $fill: {
                partitionBy: { state: '$state' },
                sortBy: { date: 1 },
                output: {
                    score: { method: 'linear' },
                    points: { value: 0 },
                },
            },
        }, 23);
        expect(fillInfo.usedFields.has('state')).toBe(true);
        expect(fillInfo.usedFields.has('date')).toBe(true);
        expect(fillInfo.producedFields.has('score')).toBe(true);
        expect(fillInfo.producedFields.has('points')).toBe(true);

        const documentsInfo = getStageInfo({
            $documents: [{ x: 1 }, { x: 2 }],
        }, 24);
        expect(documentsInfo.isDestructive).toBe(true);
        expect(documentsInfo.altersCount).toBe(true);

        const unionWithInfo = getStageInfo({
            $unionWith: {
                coll: 'archive',
                pipeline: [{ $match: { archived: true } }],
            },
        }, 25);
        expect(unionWithInfo.altersCount).toBe(true);
    });
});
