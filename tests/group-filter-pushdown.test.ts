import { describe, expect, it } from 'vitest';
import {
    proveGroupFilterPushdown,
} from '../src/passes/group-pushdown-proofs.js';
import {
    GroupFilterPushdownPass,
} from '../src/passes/group-filter-pushdown.js';
import { optimizePipeline } from '../src/index.js';
import { runMockPipeline } from './helpers/mock-engine.js';

describe('proveGroupFilterPushdown', () =>
{
    it('proves pushdown for simple 1-to-1 string _id and eliminates post-match', () =>
    {
        const group = {
            $group: {
                _id: '$userId',
                totalCount: { $sum: 1 },
            },
        };
        const match = {
            $match: {
                _id: 42,
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                userId: 42,
            },
        });
        expect(proof?.postfilterStage).toBeNull();
    });

    it('proves pushdown for subdocument _id with string field paths', () =>
    {
        const group = {
            $group: {
                _id: {
                    dept: '$department',
                    role: '$jobRole',
                },
                avgSalary: { $avg: '$salary' },
            },
        };
        const match = {
            $match: {
                '_id.dept': 'Sales',
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                department: 'Sales',
            },
        });
        expect(proof?.postfilterStage).toBeNull();
    });

    it('proves pushdown for mixed _id and accumulator conditions, keeping accumulator post-match', () =>
    {
        const group = {
            $group: {
                _id: '$userId',
                total: { $sum: '$amount' },
            },
        };
        const match = {
            $match: {
                _id: 'user-123',
                total: { $gt: 100 },
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                userId: 'user-123',
            },
        });
        expect(proof?.postfilterStage).toEqual({
            $match: {
                total: { $gt: 100 },
            },
        });
    });

    it('rejects when match only references accumulator fields', () =>
    {
        const group = {
            $group: {
                _id: '$userId',
                total: { $sum: '$amount' },
            },
        };
        const match = {
            $match: {
                total: { $gt: 100 },
            },
        };

        expect(proveGroupFilterPushdown(group, match)).toBeNull();
    });

    it('handles computed _id by pushing existence pre-filter and retaining post-match', () =>
    {
        const group = {
            $group: {
                _id: { $toUpper: '$dept' },
                count: { $sum: 1 },
            },
        };
        const match = {
            $match: {
                _id: 'SALES',
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                dept: { $exists: true, $ne: null },
            },
        });
        expect(proof?.postfilterStage).toEqual({
            $match: {
                _id: 'SALES',
            },
        });
    });

    it('proves pushdown for subdocument _id with nested dot path, full _id object, and mixed accumulator', () =>
    {
        const group = {
            $group: {
                _id: {
                    dept: '$department',
                    role: '$jobRole',
                },
                count: { $sum: 1 },
            },
        };

        // Nested dot path
        const proofDot = proveGroupFilterPushdown(group, {
            $match: { '_id.dept.code': 'ENG' },
        });
        expect(proofDot?.prefilterStage).toEqual({
            $match: { 'department.code': 'ENG' },
        });

        // Full object _id condition
        const proofObj = proveGroupFilterPushdown(group, {
            $match: { _id: { dept: 'Sales' } },
        });
        expect(proofObj?.prefilterStage).toEqual({
            $match: { department: 'Sales' },
        });

        // Rejection on unknown subfield in object or path
        expect(proveGroupFilterPushdown(group, { $match: { '_id.unknown': 1 } })).toBeNull();
        expect(proveGroupFilterPushdown(group, { $match: { _id: { unknown: 1 } } })).toBeNull();
        expect(proveGroupFilterPushdown(group, { $match: { _id: 'not-an-object' } })).toBeNull();

        // Mixed with accumulator
        const proofMixed = proveGroupFilterPushdown(group, {
            $match: { '_id.dept': 'Sales', count: { $gt: 5 } },
        });
        expect(proofMixed?.postfilterStage).toEqual({
            $match: { count: { $gt: 5 } },
        });
    });

    it('handles string _id with subfield path', () =>
    {
        const group = {
            $group: {
                _id: '$user',
                count: { $sum: 1 },
            },
        };
        const proof = proveGroupFilterPushdown(group, {
            $match: { '_id.name': 'Alice' },
        });
        expect(proof?.prefilterStage).toEqual({
            $match: { 'user.name': 'Alice' },
        });
    });

    it('rejects computed _id with invalid or multi-key operands', () =>
    {
        expect(
            proveGroupFilterPushdown(
                { $group: { _id: { $toUpper: 123 } } },
                { $match: { _id: 'A' } },
            ),
        ).toBeNull();

        expect(
            proveGroupFilterPushdown(
                { $group: { _id: { $toUpper: '$$ROOT' } } },
                { $match: { _id: 'A' } },
            ),
        ).toBeNull();

        expect(
            proveGroupFilterPushdown(
                { $group: { _id: { a: '$x', b: 123 } } },
                { $match: { _id: 'A' } },
            ),
        ).toBeNull();

        expect(
            proveGroupFilterPushdown(
                { $group: { _id: { $op1: '$a', $op2: '$b' } } },
                { $match: { _id: 'A' } },
            ),
        ).toBeNull();
    });

    it('handles null prototype and custom class objects gracefully', () =>
    {
        const nullProto = Object.create(null);
        nullProto._id = 42;
        const proof = proveGroupFilterPushdown(
            { $group: { _id: '$userId' } },
            { $match: nullProto },
        );
        expect(proof).not.toBeNull();

        class CustomClass {}
        expect(proveGroupFilterPushdown(new CustomClass(), { $match: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { _id: '$a' } }, new CustomClass())).toBeNull();
    });

    it('rejects invalid inputs gracefully', () =>
    {
        expect(proveGroupFilterPushdown(null, { $match: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: {} }, null)).toBeNull();
        expect(proveGroupFilterPushdown('not-object', { $match: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: 123 }, { $match: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { notId: 1 } }, { $match: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { _id: 123 } }, { $match: { _id: 1 } })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { _id: '$a' } }, { notMatch: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { _id: '$a' } }, { $match: 'not-object' })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { _id: '$a' }, extra: 1 }, { $match: {} })).toBeNull();
        expect(proveGroupFilterPushdown({ $group: { _id: '$a' } }, { $match: {}, extra: 1 })).toBeNull();
    });

    it('proves pushdown for $and conjunction with _id and accumulator', () =>
    {
        const group = {
            $group: {
                _id: '$userId',
                total: { $sum: '$amount' },
            },
        };
        const match = {
            $match: {
                $and: [
                    { _id: 'user-123' },
                    { total: { $gt: 100 } },
                ],
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                userId: 'user-123',
            },
        });
        expect(proof?.postfilterStage).toEqual({
            $match: {
                total: { $gt: 100 },
            },
        });
    });

    it('combines multiple pushable conjuncts on same field into $and', () =>
    {
        const group = {
            $group: {
                _id: '$userId',
                total: { $sum: '$amount' },
            },
        };
        const match = {
            $match: {
                $and: [
                    { _id: { $gte: 10 } },
                    { _id: { $lte: 50 } },
                ],
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                $and: [
                    { userId: { $gte: 10 } },
                    { userId: { $lte: 50 } },
                ],
            },
        });
        expect(proof?.postfilterStage).toBeNull();
    });

    it('proves pushdown for subdocument _id with $and conjunctions', () =>
    {
        const group = {
            $group: {
                _id: {
                    dept: '$department',
                    role: '$jobRole',
                },
                total: { $sum: '$salary' },
            },
        };
        const match = {
            $match: {
                $and: [
                    { '_id.dept': 'Sales' },
                    { '_id.role': 'Manager' },
                    { total: { $gt: 50 } },
                ],
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                department: 'Sales',
                jobRole: 'Manager',
            },
        });
        expect(proof?.postfilterStage).toEqual({
            $match: {
                total: { $gt: 50 },
            },
        });
    });

    it('proves pushdown for computed _id with $and conjunction containing null-rejecting _id', () =>
    {
        const group = {
            $group: {
                _id: { $toUpper: '$dept' },
                count: { $sum: 1 },
            },
        };
        const match = {
            $match: {
                $and: [
                    { _id: 'SALES' },
                    { count: { $gt: 5 } },
                ],
            },
        };

        const proof = proveGroupFilterPushdown(group, match);
        expect(proof).not.toBeNull();
        expect(proof?.prefilterStage).toEqual({
            $match: {
                dept: { $exists: true, $ne: null },
            },
        });
        expect(proof?.postfilterStage).toEqual({
            $match: {
                _id: 'SALES',
                count: { $gt: 5 },
            },
        });
    });
});

describe('GroupFilterPushdownPass', () =>
{
    const pass = new GroupFilterPushdownPass();

    it('has expected pass name', () =>
    {
        expect(pass.name).toBe('group-filter-pushdown');
    });

    it('pushes _id filter before $group and removes post-match for 1-to-1 mapping', () =>
    {
        const pipeline = [
            { $group: { _id: '$userId', count: { $sum: 1 } } },
            { $match: { _id: 42 } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $match: { userId: 42 } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
        ]);
    });

    it('pushes _id filter and retains accumulator post-match when mixed', () =>
    {
        const pipeline = [
            { $group: { _id: '$userId', total: { $sum: '$amount' } } },
            { $match: { _id: 42, total: { $gt: 500 } } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $match: { userId: 42 } },
            { $group: { _id: '$userId', total: { $sum: '$amount' } } },
            { $match: { total: { $gt: 500 } } },
        ]);
    });

    it('is idempotent when prefilter is already present', () =>
    {
        const pipeline = [
            { $match: { userId: 42 } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
            { $match: { _id: 42 } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual([
            { $match: { userId: 42 } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
        ]);
    });

    it('leaves pipelines without applicable group pushdown unchanged', () =>
    {
        const pipeline = [
            { $group: { _id: '$userId', total: { $sum: '$amount' } } },
            { $match: { total: { $gt: 500 } } },
        ];

        const result = pass.execute(pipeline);
        expect(result).toEqual(pipeline);
    });
});

describe('optimizePipeline execution parity for group filter pushdown', () =>
{
    const employeeDataset = [
        { _id: 1, userId: 'user-1', department: 'Sales', role: 'Manager', salary: 120, active: true },
        { _id: 2, userId: 'user-1', department: 'Sales', role: 'Rep', salary: 80, active: true },
        { _id: 3, userId: 'user-2', department: 'Engineering', role: 'Lead', salary: 150, active: true },
        { _id: 4, userId: 'user-2', department: 'Engineering', role: 'Dev', salary: 110, active: false },
        { _id: 5, userId: 'user-3', department: 'Sales', role: 'Rep', salary: 90, active: true },
        { _id: 6, userId: 'user-4', department: 'HR', role: 'Lead', salary: 95, active: true },
    ];

    it('optimizes 1-to-1 string _id group match and preserves execution parity', () =>
    {
        const pipeline = [
            {
                $group: {
                    _id: '$userId',
                    count: { $sum: 1 },
                    totalSalary: { $sum: '$salary' },
                },
            },
            {
                $match: {
                    _id: 'user-1',
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                userId: 'user-1',
            },
        });

        const originalResults = runMockPipeline(employeeDataset, pipeline);
        const optimizedResults = runMockPipeline(employeeDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toEqual([
            { _id: 'user-1', count: 2, totalSalary: 200 },
        ]);
    });

    it('optimizes subdocument _id group match with nested paths and preserves execution parity', () =>
    {
        const pipeline = [
            {
                $group: {
                    _id: {
                        dept: '$department',
                        role: '$role',
                    },
                    totalSalary: { $sum: '$salary' },
                },
            },
            {
                $match: {
                    '_id.dept': 'Sales',
                },
            },
            {
                $sort: { totalSalary: -1 },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                department: 'Sales',
            },
        });

        const originalResults = runMockPipeline(employeeDataset, pipeline);
        const optimizedResults = runMockPipeline(employeeDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults.length).toBeGreaterThan(0);
    });

    it('optimizes mixed _id and accumulator conditions and preserves execution parity', () =>
    {
        const pipeline = [
            {
                $group: {
                    _id: '$userId',
                    totalSalary: { $sum: '$salary' },
                },
            },
            {
                $match: {
                    _id: 'user-1',
                    totalSalary: { $gt: 150 },
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                userId: 'user-1',
            },
        });
        expect(optimized[optimized.length - 1]).toEqual({
            $match: {
                totalSalary: { $gt: 150 },
            },
        });

        const originalResults = runMockPipeline(employeeDataset, pipeline);
        const optimizedResults = runMockPipeline(employeeDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toEqual([
            { _id: 'user-1', totalSalary: 200 },
        ]);
    });

    it('optimizes multi-stage pipeline with preceding match and post-sort/limit', () =>
    {
        const pipeline = [
            { $match: { active: true } },
            {
                $group: {
                    _id: '$department',
                    headcount: { $sum: 1 },
                    payroll: { $sum: '$salary' },
                },
            },
            { $match: { _id: 'Sales' } },
            { $sort: { payroll: -1 } },
            { $limit: 10 },
        ];

        const optimized = optimizePipeline(pipeline);
        const originalResults = runMockPipeline(employeeDataset, pipeline);
        const optimizedResults = runMockPipeline(employeeDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toEqual([
            { _id: 'Sales', headcount: 3, payroll: 290 },
        ]);
    });

    it('optimizes $and conjunction across $group with execution parity', () =>
    {
        const pipeline = [
            {
                $group: {
                    _id: '$department',
                    headcount: { $sum: 1 },
                    payroll: { $sum: '$salary' },
                },
            },
            {
                $match: {
                    $and: [
                        { _id: 'Sales' },
                        { payroll: { $gt: 200 } },
                    ],
                },
            },
        ];

        const optimized = optimizePipeline(pipeline);
        expect(optimized[0]).toEqual({
            $match: {
                department: 'Sales',
            },
        });
        expect(optimized[optimized.length - 1]).toEqual({
            $match: {
                payroll: { $gt: 200 },
            },
        });

        const originalResults = runMockPipeline(employeeDataset, pipeline);
        const optimizedResults = runMockPipeline(employeeDataset, optimized);

        expect(optimizedResults).toEqual(originalResults);
        expect(optimizedResults).toEqual([
            { _id: 'Sales', headcount: 3, payroll: 290 },
        ]);
    });
});
