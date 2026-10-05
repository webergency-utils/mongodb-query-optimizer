import { describe, expect, it } from "vitest";
import {
  proveGroupFilterPushdown,
} from "../src/passes/group-pushdown-proofs.js";
import {
  GroupFilterPushdownPass,
} from "../src/passes/group-filter-pushdown.js";

describe("proveGroupFilterPushdown", () =>
{
  it("proves pushdown for simple 1-to-1 string _id and eliminates post-match", () =>
  {
    const group = {
      $group: {
        _id: "$userId",
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

  it("proves pushdown for subdocument _id with string field paths", () =>
  {
    const group = {
      $group: {
        _id: {
          dept: "$department",
          role: "$jobRole",
        },
        avgSalary: { $avg: "$salary" },
      },
    };
    const match = {
      $match: {
        "_id.dept": "Sales",
      },
    };

    const proof = proveGroupFilterPushdown(group, match);
    expect(proof).not.toBeNull();
    expect(proof?.prefilterStage).toEqual({
      $match: {
        department: "Sales",
      },
    });
    expect(proof?.postfilterStage).toBeNull();
  });

  it("proves pushdown for mixed _id and accumulator conditions, keeping accumulator post-match", () =>
  {
    const group = {
      $group: {
        _id: "$userId",
        total: { $sum: "$amount" },
      },
    };
    const match = {
      $match: {
        _id: "user-123",
        total: { $gt: 100 },
      },
    };

    const proof = proveGroupFilterPushdown(group, match);
    expect(proof).not.toBeNull();
    expect(proof?.prefilterStage).toEqual({
      $match: {
        userId: "user-123",
      },
    });
    expect(proof?.postfilterStage).toEqual({
      $match: {
        total: { $gt: 100 },
      },
    });
  });

  it("rejects when match only references accumulator fields", () =>
  {
    const group = {
      $group: {
        _id: "$userId",
        total: { $sum: "$amount" },
      },
    };
    const match = {
      $match: {
        total: { $gt: 100 },
      },
    };

    expect(proveGroupFilterPushdown(group, match)).toBeNull();
  });

  it("handles computed _id by pushing existence pre-filter and retaining post-match", () =>
  {
    const group = {
      $group: {
        _id: { $toUpper: "$dept" },
        count: { $sum: 1 },
      },
    };
    const match = {
      $match: {
        _id: "SALES",
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
        _id: "SALES",
      },
    });
  });

  it("proves pushdown for subdocument _id with nested dot path, full _id object, and mixed accumulator", () =>
  {
    const group = {
      $group: {
        _id: {
          dept: "$department",
          role: "$jobRole",
        },
        count: { $sum: 1 },
      },
    };

    // Nested dot path
    const proofDot = proveGroupFilterPushdown(group, {
      $match: { "_id.dept.code": "ENG" },
    });
    expect(proofDot?.prefilterStage).toEqual({
      $match: { "department.code": "ENG" },
    });

    // Full object _id condition
    const proofObj = proveGroupFilterPushdown(group, {
      $match: { _id: { dept: "Sales" } },
    });
    expect(proofObj?.prefilterStage).toEqual({
      $match: { department: "Sales" },
    });

    // Rejection on unknown subfield in object or path
    expect(proveGroupFilterPushdown(group, { $match: { "_id.unknown": 1 } })).toBeNull();
    expect(proveGroupFilterPushdown(group, { $match: { _id: { unknown: 1 } } })).toBeNull();
    expect(proveGroupFilterPushdown(group, { $match: { _id: "not-an-object" } })).toBeNull();

    // Mixed with accumulator
    const proofMixed = proveGroupFilterPushdown(group, {
      $match: { "_id.dept": "Sales", count: { $gt: 5 } },
    });
    expect(proofMixed?.postfilterStage).toEqual({
      $match: { count: { $gt: 5 } },
    });
  });

  it("handles string _id with subfield path", () =>
  {
    const group = {
      $group: {
        _id: "$user",
        count: { $sum: 1 },
      },
    };
    const proof = proveGroupFilterPushdown(group, {
      $match: { "_id.name": "Alice" },
    });
    expect(proof?.prefilterStage).toEqual({
      $match: { "user.name": "Alice" },
    });
  });

  it("rejects computed _id with invalid or multi-key operands", () =>
  {
    expect(
      proveGroupFilterPushdown(
        { $group: { _id: { $toUpper: 123 } } },
        { $match: { _id: "A" } },
      ),
    ).toBeNull();

    expect(
      proveGroupFilterPushdown(
        { $group: { _id: { $toUpper: "$$ROOT" } } },
        { $match: { _id: "A" } },
      ),
    ).toBeNull();

    expect(
      proveGroupFilterPushdown(
        { $group: { _id: { a: "$x", b: 123 } } },
        { $match: { _id: "A" } },
      ),
    ).toBeNull();

    expect(
      proveGroupFilterPushdown(
        { $group: { _id: { $op1: "$a", $op2: "$b" } } },
        { $match: { _id: "A" } },
      ),
    ).toBeNull();
  });

  it("handles null prototype and custom class objects gracefully", () =>
  {
    const nullProto = Object.create(null);
    nullProto._id = 42;
    const proof = proveGroupFilterPushdown(
      { $group: { _id: "$userId" } },
      { $match: nullProto },
    );
    expect(proof).not.toBeNull();

    class CustomClass {}
    expect(proveGroupFilterPushdown(new CustomClass(), { $match: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { _id: "$a" } }, new CustomClass())).toBeNull();
  });

  it("rejects invalid inputs gracefully", () =>
  {
    expect(proveGroupFilterPushdown(null, { $match: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: {} }, null)).toBeNull();
    expect(proveGroupFilterPushdown("not-object", { $match: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: 123 }, { $match: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { notId: 1 } }, { $match: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { _id: 123 } }, { $match: { _id: 1 } })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { _id: "$a" } }, { notMatch: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { _id: "$a" } }, { $match: "not-object" })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { _id: "$a" }, extra: 1 }, { $match: {} })).toBeNull();
    expect(proveGroupFilterPushdown({ $group: { _id: "$a" } }, { $match: {}, extra: 1 })).toBeNull();
  });
});

describe("GroupFilterPushdownPass", () =>
{
  const pass = new GroupFilterPushdownPass();

  it("has expected pass name", () =>
  {
    expect(pass.name).toBe("group-filter-pushdown");
  });

  it("pushes _id filter before $group and removes post-match for 1-to-1 mapping", () =>
  {
    const pipeline = [
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $match: { _id: 42 } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual([
      { $match: { userId: 42 } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]);
  });

  it("pushes _id filter and retains accumulator post-match when mixed", () =>
  {
    const pipeline = [
      { $group: { _id: "$userId", total: { $sum: "$amount" } } },
      { $match: { _id: 42, total: { $gt: 500 } } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual([
      { $match: { userId: 42 } },
      { $group: { _id: "$userId", total: { $sum: "$amount" } } },
      { $match: { total: { $gt: 500 } } },
    ]);
  });

  it("is idempotent when prefilter is already present", () =>
  {
    const pipeline = [
      { $match: { userId: 42 } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $match: { _id: 42 } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual([
      { $match: { userId: 42 } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]);
  });

  it("leaves pipelines without applicable group pushdown unchanged", () =>
  {
    const pipeline = [
      { $group: { _id: "$userId", total: { $sum: "$amount" } } },
      { $match: { total: { $gt: 500 } } },
    ];

    const result = pass.execute(pipeline);
    expect(result).toEqual(pipeline);
  });
});
