import { describe, expect, it } from 'vitest';
import { optimizePipeline } from '../src/index.js';
import { LookupDelayPass } from '../src/passes/lookup-delay.js';
import {
    proveLookupDelayAcrossStage,
    proveRedundantLookupElimination,
} from '../src/passes/movement-proofs.js';
import {
    isExactPathDiscardedByFollower,
    proveSimpleProjectAdvanceAcrossSort,
    proveUnusedFieldPruning,
} from '../src/passes/projection-proofs.js';
import { RedundantLookupEliminationPass } from '../src/passes/redundant-lookup-elimination.js';
import {
    optimizePipelineWithCandidateProfile,
} from '../src/passes/registry.js';
import { SortProjectCommutePass } from '../src/passes/sort-project-commute.js';
import { UnusedFieldPruningPass } from '../src/passes/unused-field-pruning.js';

type Stage = Record<string, unknown>;

function lookup(
    overrides: Record<string, unknown> = {},
): Stage
{
    return {
        $lookup: {
            from: 'orders',
            localField: 'customerId',
            foreignField: 'customerId',
            as: 'orders',
            ...overrides,
        },
    };
}

function optimizeWith(
    pipeline: Stage[],
    transformationIds: readonly string[],
): Stage[]
{
    return optimizePipelineWithCandidateProfile(
        pipeline,
        transformationIds,
        [],
    ) as Stage[];
}

describe('unused-field pruning proofs', () =>
{
    it.each([
        [
            'set plus exact unset removes only the dead write',
            { $set: { dead: '$source', retained: '$name' } },
            { $unset: 'dead' },
            {
                replacementStage: { $set: { retained: '$name' } },
                removedFields: ['dead'],
            },
        ],
        [
            'addFields plus multi-unset removes the whole stage',
            { $addFields: { first: 1, second: 2 } },
            { $unset: ['first', 'second'] },
            {
                replacementStage: null,
                removedFields: ['first', 'second'],
            },
        ],
        [
            'literal document assignment is prunable',
            { $addFields: { dead: { nested: 'constant' } } },
            { $unset: 'dead' },
            {
                replacementStage: null,
                removedFields: ['dead'],
            },
        ],
        [
            'array assignment is prunable',
            { $set: { dead: ['$source', 1] } },
            { $unset: 'dead' },
            {
                replacementStage: null,
                removedFields: ['dead'],
            },
        ],
        [
            'inclusion project hides an unused write',
            { $addFields: { dead: '$source', retained: '$name' } },
            { $project: { name: 1, retained: 1 } },
            {
                replacementStage: { $addFields: { retained: '$name' } },
                removedFields: ['dead'],
            },
        ],
        [
            'boolean inclusion flags hide unused writes',
            { $addFields: { dead: 1, kept: 2 } },
            { $project: { kept: true } },
            {
                replacementStage: { $addFields: { kept: 2 } },
                removedFields: ['dead'],
            },
        ],
        [
            'exclusion project removes the written field',
            { $addFields: { dead: 1 } },
            { $project: { dead: 0 } },
            {
                replacementStage: null,
                removedFields: ['dead'],
            },
        ],
        [
            'boolean exclusion removes the written field',
            { $set: { dead: '$source' } },
            { $project: { dead: false } },
            {
                replacementStage: null,
                removedFields: ['dead'],
            },
        ],
        [
            'overwrite of a suffix field removes only that write',
            { $addFields: { retained: 1, overwritten: '$source' } },
            { $set: { overwritten: 2 } },
            {
                replacementStage: { $addFields: { retained: 1 } },
                removedFields: ['overwritten'],
            },
        ],
        [
            'complete overwrite removes the source stage',
            { $set: { overwritten: 1 } },
            { $addFields: { overwritten: '$source' } },
            {
                replacementStage: null,
                removedFields: ['overwritten'],
            },
        ],
    ])('%s', (_name, source, follower, expected) =>
    {
        expect(proveUnusedFieldPruning(source, follower)).toEqual(expected);
    });

    it.each([
        ['null source', null, { $unset: 'dead' }],
        ['empty addFields', { $addFields: {} }, { $unset: 'dead' }],
        ['project source', { $project: { dead: 1 } }, { $unset: 'dead' }],
        ['computed project source', { $project: { dead: { $add: ['$source', 1] } } }, { $unset: 'dead' }],
        ['non-adjacent kill', { $addFields: { dead: 1 } }, { $sort: { dead: 1 } }],
        ['match follower', { $addFields: { dead: 1 } }, { $match: { dead: 1 } }],
        ['limit follower', { $addFields: { dead: 1 } }, { $limit: 1 }],
        ['dotted write plus dotted unset', { $addFields: { 'profile.name': 'Ada' } }, { $unset: 'profile.name' }],
        ['object write plus child unset', { $addFields: { profile: { name: 'Ada' } } }, { $unset: 'profile.name' }],
        ['dotted write plus parent unset', { $addFields: { 'profile.name': 'Ada' } }, { $unset: 'profile' }],
        ['colliding addFields', { $addFields: { profile: 1, 'profile.name': 2 } }, { $unset: 'profile' }],
        ['dollar path', { $addFields: { '$invalid': 1 } }, { $unset: 'dead' }],
        ['empty unset list', { $addFields: { dead: 1 } }, { $unset: [] }],
        ['non-string unset', { $addFields: { dead: 1 } }, { $unset: 1 }],
        ['exclusion that keeps the write', { $addFields: { kept: 1 } }, { $project: { secret: 0 } }],
        ['inclusion that keeps the write', { $addFields: { kept: 1 } }, { $project: { kept: 1 } }],
        ['volatile write', { $addFields: { dead: { $rand: {} } } }, { $unset: 'dead' }],
        ['dividing write', { $addFields: { dead: { $divide: [1, '$zero'] } } }, { $unset: 'dead' }],
        ['type-sensitive add', { $addFields: { dead: { $add: ['$untyped', 1] } } }, { $unset: 'dead' }],
        ['malformed equality', { $addFields: { dead: { $eq: ['$missing'] } } }, { $unset: 'dead' }],
        ['unknown operator', { $addFields: { dead: { $unknownOperator: '$source' } } }, { $unset: 'dead' }],
        ['getField write', { $addFields: { dead: { $getField: 'source' } } }, { $unset: 'dead' }],
        ['ROOT write', { $addFields: { dead: '$$ROOT' } }, { $unset: 'dead' }],
        ['CURRENT write', { $addFields: { dead: '$$CURRENT' } }, { $unset: 'dead' }],
        ['unbound variable write', { $set: { dead: { nested: '$$unbound.value' } } }, { $unset: 'dead' }],
        ['overwrite that reads the field', { $addFields: { dead: 1, retained: 2 } }, { $set: { dead: '$dead' } }],
        ['overwrite that reads ROOT', { $addFields: { dead: 1 } }, { $set: { dead: '$$ROOT' } }],
        ['overwrite that reads CURRENT', { $addFields: { dead: 1 } }, { $set: { dead: '$$CURRENT.dead' } }],
        ['overwrite field-order barrier', { $set: { retained: 0, first: 1, second: 2 } }, { $set: { first: 3, final: 4 } }],
        ['computed inclusion project follower', { $addFields: { dead: 1 } }, { $project: { dead: { $literal: 1 } } }],
        ['mixed project follower', { $addFields: { dead: 1 } }, { $project: { dead: 0, name: 1 } }],
        ['dotted project follower', { $addFields: { dead: 1 } }, { $project: { 'profile.name': 1 } }],
    ])('rejects %s', (_name, source, follower) =>
    {
        expect(proveUnusedFieldPruning(source, follower)).toBeNull();
    });
});

describe('unused-field pruning pass', () =>
{
    it('replaces a partial dead write and stops after one adjacent proof', () =>
    {
        const pipeline = [
            { $set: { first: 1, second: 2 } },
            { $unset: 'first' },
            { $addFields: { third: 3 } },
            { $unset: 'third' },
        ];
        const snapshot = structuredClone(pipeline);

        expect(new UnusedFieldPruningPass().execute(pipeline)).toEqual([
            { $set: { second: 2 } },
            { $unset: 'first' },
            { $addFields: { third: 3 } },
            { $unset: 'third' },
        ]);
        expect(pipeline).toEqual(snapshot);
        expect(optimizeWith(pipeline, ['unused-field-pruning'])).toEqual([
            { $set: { second: 2 } },
            { $unset: 'first' },
            { $unset: 'third' },
        ]);
    });

    it('removes a fully killed addFields stage', () =>
    {
        expect(new UnusedFieldPruningPass().execute([
            { $addFields: { dead: 1 } },
            { $project: { name: 1 } },
        ])).toEqual([
            { $project: { name: 1 } },
        ]);
    });

    it.each([
        [[], []],
        [[{ $addFields: { dead: 1 } }], [{ $addFields: { dead: 1 } }]],
        [[{ $match: { active: true } }, { $limit: 1 }], [{ $match: { active: true } }, { $limit: 1 }]],
    ])('is a no-op for %#', (pipeline, expected) =>
    {
        expect(new UnusedFieldPruningPass().execute(pipeline)).toEqual(expected);
    });
});

describe('path discard proofs', () =>
{
    it.each([
        ['orders', { $unset: 'orders' }],
        ['orders', { $unset: ['temporary', 'orders'] }],
        ['orders', { $project: { name: 1 } }],
        ['orders', { $project: { name: true, _id: false } }],
        ['orders', { $project: { orders: 0 } }],
        ['orders', { $project: { orders: false } }],
        ['orders.items', { $project: { name: 1 } }],
    ])('discards %s through %j', (path, follower) =>
    {
        expect(isExactPathDiscardedByFollower(path, follower)).toBe(true);
    });

    it.each([
        ['orders', { $unset: 'other' }],
        ['orders', { $unset: 'orders.total' }],
        ['orders', { $unset: [] }],
        ['orders', { $unset: ['orders.total'] }],
        ['orders', { $limit: 1 }],
        ['orders', { $match: { name: 'Ada' } }],
        ['orders', { $sort: { name: 1 } }],
        ['orders', { $project: { orders: 1 } }],
        ['orders', { $project: { 'orders.total': 1 } }],
        ['orders', { $project: { secret: 0 } }],
        ['orders', { $project: { name: { $toUpper: '$name' } } }],
        ['orders', { $addFields: { stable: true } }],
        ['orders', null],
    ])('keeps %s in front of %j', (path, follower) =>
    {
        expect(isExactPathDiscardedByFollower(path, follower)).toBe(false);
    });
});

describe('redundant lookup elimination proofs', () =>
{
    it.each([
        [{ $project: { name: 1 } }],
        [{ $project: { _id: 0, name: 1 } }],
        [{ $project: { name: true } }],
        [{ $project: { orders: 0 } }],
        [{ $project: { orders: false } }],
        [{ $unset: 'orders' }],
        [{ $unset: ['orders', 'temporary'] }],
    ])('eliminates a simple lookup before %j', (follower) =>
    {
        expect(proveRedundantLookupElimination(lookup(), follower)).toBe(true);
    });

    it.each([
        [null],
        [{ $lookup: 'orders' }],
        [lookup({ pipeline: [] })],
        [lookup({ let: { id: '$customerId' } })],
        [lookup({ extraOption: true })],
        [lookup({ from: '' })],
        [lookup({ localField: '' })],
        [lookup({ foreignField: '' })],
        [lookup({ as: '' })],
        [lookup({ from: 1 })],
        [lookup({ as: 1 })],
        [{ $lookup: { from: 'orders', localField: 'customerId', as: 'orders' } }],
        [{
            $graphLookup: {
                from: 'employees',
                startWith: '$managerId',
                connectFromField: 'managerId',
                connectToField: '_id',
                as: 'orders',
            },
        }],
    ])('rejects a non-simple lookup %#', (stage) =>
    {
        expect(proveRedundantLookupElimination(stage, { $project: { name: 1 } }))
            .toBe(false);
    });

    it.each([
        [{ $project: { name: 1, orders: 1 } }],
        [{ $project: { 'orders.total': 1 } }],
        [{ $project: { secret: 0 } }],
        [{ $project: { name: { $toUpper: '$name' } } }],
        [{ $unset: 'temporary' }],
        [{ $unset: 'orders.total' }],
        [{ $unset: '$orders' }],
        [{ $match: { name: 'Ada' } }],
        [{ $sort: { score: -1 } }],
        [{ $limit: 1 }],
        [{ $skip: 1 }],
        [{ $unwind: '$items' }],
        [{ $unwind: '$orders' }],
        [{ $group: { _id: '$status' } }],
        [{ $addFields: { stable: true } }],
    ])('keeps a simple lookup before %j', (follower) =>
    {
        expect(proveRedundantLookupElimination(lookup(), follower)).toBe(false);
    });
});

describe('redundant lookup elimination pass', () =>
{
    it('removes one adjacent unused lookup and leaves later lookups', () =>
    {
        const pipeline = [
            lookup(),
            { $project: { name: 1 } },
            lookup({ as: 'otherOrders' }),
            { $unset: 'otherOrders' },
        ];
        const snapshot = structuredClone(pipeline);

        expect(new RedundantLookupEliminationPass().execute(pipeline)).toEqual([
            { $project: { name: 1 } },
            lookup({ as: 'otherOrders' }),
            { $unset: 'otherOrders' },
        ]);
        expect(pipeline).toEqual(snapshot);
        expect(optimizeWith(pipeline, ['redundant-lookup-elimination'])).toEqual([
            { $project: { name: 1 } },
            { $unset: 'otherOrders' },
        ]);
    });

    it.each([
        [[lookup()], [lookup()]],
        [
            [lookup(), { $unwind: '$orders' }, { $project: { name: 1 } }],
            [lookup(), { $unwind: '$orders' }, { $project: { name: 1 } }],
        ],
        [
            [lookup(), { $match: { name: 'Ada' } }],
            [lookup(), { $match: { name: 'Ada' } }],
        ],
    ])('does not eliminate %#', (pipeline, expected) =>
    {
        expect(new RedundantLookupEliminationPass().execute(pipeline)).toEqual(
            expected,
        );
    });
});

describe('lookup delay proofs', () =>
{
    it.each([
        [{ $match: { status: 'active' } }],
        [{ $match: { customerId: 'customer-one' } }],
        [{ $sort: { score: 1 } }],
        [{ $sort: { score: -1, _id: 1 } }],
        [{ $limit: 2 }],
        [{ $skip: 0 }],
        [{ $skip: 3 }],
    ])('delays a simple lookup past %j', (follower) =>
    {
        expect(proveLookupDelayAcrossStage(lookup(), follower)).toBe(true);
    });

    it.each([
        [lookup({ pipeline: [] }), { $sort: { score: -1 } }],
        [lookup({ let: { id: '$customerId' } }), { $limit: 1 }],
        [lookup({ as: '' }), { $match: { status: 'active' } }],
        [lookup(), { $match: { orders: { $ne: [] } } }],
        [lookup(), { $match: { 'orders.total': { $gt: 0 } } }],
        [lookup(), { $sort: { 'orders.total': -1 } }],
        [lookup(), { $match: { $where: 'return true' } }],
        [lookup(), { $match: { $expr: { $gt: [{ $rand: {} }, 0.5] } } }],
        [lookup(), { $unset: 'temporary' }],
        [lookup(), { $project: { customerId: 1 } }],
        [lookup(), { $addFields: { stable: true } }],
        [lookup(), { $set: { stable: true } }],
        [lookup(), { $unwind: '$items' }],
        [lookup(), { $group: { _id: '$status' } }],
        [lookup(), { $facet: { selected: [{ $limit: 1 }] } }],
        [lookup(), { $unionWith: 'archive' }],
        [lookup(), { $limit: 0 }],
        [lookup(), { $limit: '1' }],
        [lookup(), { $sort: { score: 'desc' } }],
        [lookup(), lookup({ as: 'otherOrders' })],
    ])('does not delay %j past %j', (stage, follower) =>
    {
        expect(proveLookupDelayAcrossStage(stage, follower)).toBe(false);
    });
});

describe('lookup delay pass', () =>
{
    it('swaps one adjacent pair and stops', () =>
    {
        const pipeline = [
            lookup(),
            { $sort: { score: -1 } },
            { $limit: 1 },
        ];

        expect(new LookupDelayPass().execute(pipeline)).toEqual([
            { $sort: { score: -1 } },
            lookup(),
            { $limit: 1 },
        ]);
        expect(optimizeWith(pipeline, ['lookup-delay'])).toEqual([
            { $sort: { score: -1 } },
            { $limit: 1 },
            lookup(),
        ]);
    });
});

describe('sort-project commute proofs', () =>
{
    it.each([
        [{ $sort: { age: 1 } }, { $project: { name: 1, age: 1 } }],
        [{ $sort: { age: -1 } }, { $project: { age: true } }],
        [{ $sort: { age: 1, _id: 1 } }, { $project: { age: 1 } }],
        [{ $sort: { _id: -1 } }, { $project: { name: 1 } }],
        [{ $sort: { score: 1 } }, { $project: { secret: 0 } }],
        [{ $sort: { 'profile.age': 1 } }, { $project: { profile: 1 } }],
    ])('commutes %j before %j', (sort, project) =>
    {
        expect(proveSimpleProjectAdvanceAcrossSort(sort, project)).toBe(true);
    });

    it.each([
        [null, { $project: { age: 1 } }],
        [{ $limit: 1 }, { $project: { age: 1 } }],
        [{ $sort: 'age' }, { $project: { age: 1 } }],
        [{ $sort: {} }, { $project: { age: 1 } }],
        [{ $sort: { age: 'desc' } }, { $project: { age: 1 } }],
        [{ $sort: { age: 2 } }, { $project: { age: 1 } }],
        [{ $sort: { age: 1 }, $limit: 1 }, { $project: { age: 1 } }],
        [{ $sort: { age: 1 } }, { $project: { name: 1 } }],
        [{ $sort: { age: 1, score: -1 } }, { $project: { age: 1 } }],
        [{ $sort: { age: 1 } }, { $project: { age: 0 } }],
        [{ $sort: { age: 1 } }, { $project: { age: { $add: ['$age', 1] } } }],
        [{ $sort: { age: 1 } }, { $project: { 'profile.age': 1 } }],
        [{ $sort: { age: 1 } }, { $unset: 'secret' }],
        [{ $sort: { age: 1 } }, { $addFields: { age: 1 } }],
        [{ $sort: { '': 1 } }, { $project: { name: 1 } }],
        [{ $sort: { 'a..b': 1 } }, { $project: { name: 1 } }],
        [{ $sort: { '$invalid': 1 } }, { $project: { name: 1 } }],
        [{ $project: { age: 1 } }, { $sort: { age: 1 } }],
    ])('rejects %j then %j', (left, right) =>
    {
        expect(proveSimpleProjectAdvanceAcrossSort(left, right)).toBe(false);
    });
});

describe('sort-project commute pass', () =>
{
    it('swaps one adjacent pair and leaves later pairs', () =>
    {
        const pipeline = [
            { $sort: { age: 1 } },
            { $project: { name: 1, age: 1 } },
            { $sort: { name: 1 } },
            { $project: { name: 1, age: 1 } },
        ];
        const snapshot = structuredClone(pipeline);

        expect(new SortProjectCommutePass().execute(pipeline)).toEqual([
            { $project: { name: 1, age: 1 } },
            { $sort: { age: 1 } },
            { $sort: { name: 1 } },
            { $project: { name: 1, age: 1 } },
        ]);
        expect(pipeline).toEqual(snapshot);
        expect(optimizeWith(
            [
                { $match: { active: true } },
                { $sort: { age: 1 } },
                { $project: { name: 1, age: 1 } },
            ],
            ['sort-project-commute'],
        )).toEqual([
            { $match: { active: true } },
            { $project: { name: 1, age: 1 } },
            { $sort: { age: 1 } },
        ]);
    });

    it.each([
        [[{ $sort: { age: 1 } }], [{ $sort: { age: 1 } }]],
        [
            [{ $sort: { age: 1 } }, { $project: { name: 1 } }],
            [{ $sort: { age: 1 } }, { $project: { name: 1 } }],
        ],
        [
            [{ $project: { name: 1, age: 1 } }, { $sort: { age: 1 } }],
            [{ $project: { name: 1, age: 1 } }, { $sort: { age: 1 } }],
        ],
    ])('is a no-op for %#', (pipeline, expected) =>
    {
        expect(new SortProjectCommutePass().execute(pipeline)).toEqual(expected);
    });
});

describe('production successful-result rewrites', () =>
{
    it.each([
        [
            'prunes a dead addFields write before unset',
            [{ $addFields: { dead: '$source' } }, { $unset: 'dead' }],
            [{ $unset: 'dead' }],
        ],
        [
            'prunes a dead set write before inclusion project',
            [{ $set: { dead: 1, kept: 2 } }, { $project: { kept: 1 } }],
            [{ $set: { kept: 2 } }, { $project: { kept: 1 } }],
        ],
        [
            'prunes a dead write after sort and an unrelated unset',
            [
                { $addFields: { dead: 1, kept: 2 } },
                { $unset: 'temporary' },
                { $sort: { kept: 1 } },
                { $unset: 'dead' },
            ],
            [
                { $addFields: { kept: 2 } },
                { $unset: 'temporary' },
                { $sort: { kept: 1 } },
                { $unset: 'dead' },
            ],
        ],
        [
            'eliminates an unused simple lookup before project',
            [lookup(), { $project: { _id: 0, name: 1 } }],
            [{ $project: { _id: 0, name: 1 } }],
        ],
        [
            'eliminates an unused simple lookup before unset',
            [lookup(), { $unset: 'orders' }],
            [{ $unset: 'orders' }],
        ],
        [
            'delays lookup past match then limit',
            [lookup(), { $match: { status: 'active' } }, { $limit: 1 }],
            [{ $match: { status: 'active' } }, { $limit: 1 }, lookup()],
        ],
        [
            'commutes sort and project when keys are kept',
            [{ $sort: { age: 1 } }, { $project: { name: 1, age: 1 } }],
            [{ $project: { name: 1, age: 1 } }, { $sort: { age: 1 } }],
        ],
        [
            'commutes sort and exclusion project that keeps the key',
            [{ $sort: { age: 1 } }, { $project: { secret: 0 } }],
            [{ $project: { secret: 0 } }, { $sort: { age: 1 } }],
        ],
        [
            'defers a safe addFields past a disjoint sort',
            [{ $addFields: { label: '$name' } }, { $sort: { score: -1 } }],
            [{ $sort: { score: -1 } }, { $addFields: { label: '$name' } }],
        ],
        [
            'defers a safe set past a disjoint sort',
            [{ $set: { label: 1 } }, { $sort: { _id: 1 } }],
            [{ $sort: { _id: 1 } }, { $set: { label: 1 } }],
        ],
    ])('%s', (_name, pipeline, expected) =>
    {
        const snapshot = structuredClone(pipeline);

        const once = optimizePipeline(pipeline);
        const twice = optimizePipeline(once);

        expect(pipeline).toEqual(snapshot);
        expect(once).toEqual(expected);
        expect(twice).toEqual(once);
    });

    it.each([
        [
            'does not prune a volatile dead write',
            [{ $set: { dead: { $rand: {} } } }, { $unset: 'dead' }],
        ],
        [
            'does not prune a dead write across a sort that reads it',
            [
                { $addFields: { dead: 1 } },
                { $sort: { dead: 1 } },
                { $unset: 'dead' },
            ],
        ],
        [
            'does not prune a dead write across an exclusion project',
            [
                { $addFields: { dead: 1 } },
                { $project: { secret: 0 } },
                { $unset: 'dead' },
            ],
        ],
        [
            'does not prune a dead write across a ROOT snapshot',
            [
                { $addFields: { dead: 1 } },
                { $set: { snapshot: '$$ROOT' } },
                { $unset: 'dead' },
            ],
        ],
        [
            'does not prune a computed project before unset',
            [{ $project: { computed: { $add: ['$source', 1] } } }, { $unset: 'computed' }],
        ],
        [
            'does not eliminate lookup plus preserving unwind',
            [
                lookup(),
                { $unwind: { path: '$orders', preserveNullAndEmptyArrays: true } },
                { $project: { _id: 0, name: 1 } },
            ],
        ],
        [
            'does not eliminate lookup plus dropping unwind',
            [lookup(), { $unwind: '$orders' }, { $unset: 'orders' }],
        ],
        [
            'does not eliminate a lookup whose alias is kept',
            [lookup(), { $project: { _id: 0, name: 1, orders: 1 } }],
        ],
        [
            'does not delay lookup past a project',
            [lookup(), { $project: { customerId: 1, orders: 1 } }],
        ],
        [
            'does not delay graph lookup',
            [
                {
                    $graphLookup: {
                        from: 'employees',
                        startWith: '$managerId',
                        connectFromField: 'managerId',
                        connectToField: '_id',
                        as: 'reports',
                    },
                },
                { $sort: { score: -1 } },
            ],
        ],
        [
            'does not commute sort past a project that drops the key',
            [{ $sort: { age: 1 } }, { $project: { name: 1 } }],
        ],
        [
            'does not commute sort past a computed project',
            [{ $sort: { age: 1 } }, { $project: { age: { $add: ['$age', 1] } } }],
        ],
        [
            'does not defer an erroring addFields past sort',
            [{ $addFields: { computed: { $add: ['$source', 1] } } }, { $sort: { score: -1 } }],
        ],
        [
            'does not defer an addFields that overwrites a sort key',
            [{ $addFields: { score: 1 } }, { $sort: { score: -1 } }],
        ],
        [
            'does not move unwind before limit',
            [{ $unwind: '$items' }, { $limit: 1 }],
        ],
        [
            'does not move group before limit',
            [{ $group: { _id: '$status', count: { $sum: 1 } } }, { $limit: 1 }],
        ],
        [
            'does not move limit before unwind',
            [{ $limit: 1 }, { $unwind: '$items' }],
        ],
        [
            'does not move limit before group',
            [{ $limit: 1 }, { $group: { _id: '$status' } }],
        ],
        [
            'does not generic-reorder sort past unused project keys only',
            [{ $sort: { score: -1 } }, { $project: { _id: 0, name: 1 } }],
        ],
    ])('%s', (_name, pipeline) =>
    {
        expect(optimizePipeline(pipeline)).toEqual(pipeline);
    });

    it('prunes dead writes instead of swapping them with the killer', () =>
    {
        expect(optimizePipeline([
            { $addFields: { transient: '$source' } },
            { $unset: 'transient' },
        ])).toEqual([
            { $unset: 'transient' },
        ]);
        expect(optimizePipeline([
            { $addFields: { transient: '$source' } },
            { $project: { _id: 0, source: 1 } },
        ])).toEqual([
            { $project: { _id: 0, source: 1 } },
        ]);
    });
});

describe('nested successful-result rewrites', () =>
{
    it('applies pruning, elimination, and sort-project commute inside children', () =>
    {
        const pipeline = [
            {
                $facet: {
                    pruned: [
                        { $addFields: { dead: 1, kept: 2 } },
                        { $project: { kept: 1 } },
                    ],
                    sorted: [
                        { $sort: { score: -1 } },
                        { $project: { name: 1, score: 1 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'accounts',
                    pipeline: [
                        lookup({ from: 'orders' }),
                        { $project: { name: 1 } },
                    ],
                    as: 'accounts',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        lookup({ from: 'unionOrders' }),
                        { $unset: 'orders' },
                    ],
                },
            },
        ];

        expect(optimizePipeline(pipeline)).toEqual([
            {
                $facet: {
                    pruned: [
                        { $addFields: { kept: 2 } },
                        { $project: { kept: 1 } },
                    ],
                    sorted: [
                        { $project: { name: 1, score: 1 } },
                        { $sort: { score: -1 } },
                    ],
                },
            },
            {
                $lookup: {
                    from: 'accounts',
                    pipeline: [
                        { $project: { name: 1 } },
                    ],
                    as: 'accounts',
                },
            },
            {
                $unionWith: {
                    coll: 'archive',
                    pipeline: [
                        { $unset: 'orders' },
                    ],
                },
            },
        ]);
    });
});

describe('high-ROI aggregation optimization passes end-to-end rewrites', () =>
{
    it('normalizes $expr comparisons to native match and merges adjacent matches', () =>
    {
        const pipeline = [
            { $match: { $expr: { $eq: ['$status', 'active'] } } },
            { $match: { score: { $gte: 10 } } },
        ];
        expect(optimizePipeline(pipeline)).toEqual([
            { $match: { status: 'active', score: { $gte: 10 } } },
        ]);
    });

    it('pushes down group _id filter and eliminates 1-to-1 post-match', () =>
    {
        const pipeline = [
            {
                $group: {
                    _id: '$tenantId',
                    total: { $sum: 1 },
                },
            },
            { $match: { _id: 'acme' } },
        ];
        expect(optimizePipeline(pipeline)).toEqual([
            { $match: { tenantId: 'acme' } },
            {
                $group: {
                    _id: '$tenantId',
                    total: { $sum: 1 },
                },
            },
        ]);
    });

    it('synthesizes $elemMatch prefilter before $unwind while preserving downstream match', () =>
    {
        const pipeline = [
            { $unwind: '$items' },
            { $match: { 'items.price': { $gt: 50 } } },
        ];
        expect(optimizePipeline(pipeline)).toEqual([
            { $match: { items: { $elemMatch: { price: { $gt: 50 } } } } },
            { $unwind: '$items' },
            { $match: { 'items.price': { $gt: 50 } } },
        ]);
    });

    it('hoists common pipeline prefix out of $facet branches', () =>
    {
        const pipeline = [
            {
                $facet: {
                    branchA: [
                        { $match: { orgId: 'corp' } },
                        { $project: { name: 1 } },
                        { $count: 'total' },
                    ],
                    branchB: [
                        { $match: { orgId: 'corp' } },
                        { $project: { name: 1 } },
                        { $group: { _id: '$name' } },
                    ],
                },
            },
        ];
        expect(optimizePipeline(pipeline)).toEqual([
            { $match: { orgId: 'corp' } },
            { $project: { name: 1 } },
            {
                $facet: {
                    branchA: [{ $count: 'total' }],
                    branchB: [{ $group: { _id: '$name' } }],
                },
            },
        ]);
    });
});

