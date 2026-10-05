import { describe, expect, it } from "vitest";
import {
  runMockPipeline,
} from "./helpers/mock-engine.js";

describe("MongoDB-aligned mock boundaries (supplemental only)", () =>
{
  it("emits no count document for an empty input stream", () =>
  {
    expect(runMockPipeline([], [{ $count: "total" }])).toEqual([]);
  });

  it("preserves empty, missing, and null unwind inputs distinctly", () =>
  {
    const result = runMockPipeline([
      { _id: 1, values: [] },
      { _id: 2 },
      { _id: 3, values: null },
    ], [{
      $unwind: {
        path: "$values",
        preserveNullAndEmptyArrays: true,
        includeArrayIndex: "index",
      },
    }]);

    expect(result).toEqual([
      { _id: 1, index: null },
      { _id: 2, index: null },
      { _id: 3, values: null, index: null },
    ]);
    expect("values" in result[0]!).toBe(false);
    expect("values" in result[1]!).toBe(false);
  });

  it("distinguishes computed inclusion from exclusion projection mode", () =>
  {
    expect(runMockPipeline([
      {
        _id: 1,
        kept: "yes",
        nested: { kept: true, removed: true },
      },
    ], [{
      $project: {
        constant: 5,
        array: [],
        object: {},
        missing: 1,
        _id: 0,
      },
    }])).toEqual([
      {
        constant: 5,
        array: [],
        object: {},
      },
    ]);

    expect(runMockPipeline([
      {
        _id: 1,
        nested: { kept: true, removed: true },
      },
    ], [{
      $project: {
        "nested.removed": 0,
      },
    }])).toEqual([
      {
        _id: 1,
        nested: { kept: true },
      },
    ]);

    expect(() => runMockPipeline(
      [{ _id: 1, kept: true, removed: true }],
      [{ $project: { kept: 1, removed: 0 } }],
    )).toThrow("invalid mixed projection");
    expect(() => runMockPipeline(
      [{ _id: 1 }],
      [{ $project: {} }],
    )).toThrow("empty projection");
  });

  it("rejects invalid logical arrays instead of inventing match semantics", () =>
  {
    for (const filter of [
      { $and: [] },
      { $or: [] },
      { $and: { value: 1 } },
      { value: { $in: 1 } },
    ])
    {
      expect(() => runMockPipeline(
        [{ _id: 1, value: 1 }],
        [{ $match: filter }],
      )).toThrow();
    }
  });

  it("evaluates $facet subpipelines independently and bundles results into a document", () =>
  {
    const data = [
      { _id: 1, category: "electronics", price: 100 },
      { _id: 2, category: "books", price: 20 },
      { _id: 3, category: "electronics", price: 200 },
    ];
    const pipeline = [
      {
        $facet: {
          categories: [
            { $group: { _id: "$category", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          totalPrice: [
            { $group: { _id: null, total: { $sum: "$price" } } },
          ],
        },
      },
    ];

    const result = runMockPipeline(data, pipeline);
    expect(result).toHaveLength(1);
    expect(result[0].categories).toHaveLength(2);
    expect(result[0].totalPrice).toEqual([{ _id: null, total: 320 }]);
  });

  it("evaluates diverse $group accumulators ($avg, $min, $max, $first, $last, $push)", () =>
  {
    const data = [
      { _id: 1, group: "A", val: 10 },
      { _id: 2, group: "A", val: 30 },
      { _id: 3, group: "B", val: 50 },
    ];
    const pipeline = [
      {
        $group: {
          _id: "$group",
          avgVal: { $avg: "$val" },
          minVal: { $min: "$val" },
          maxVal: { $max: "$val" },
          firstVal: { $first: "$val" },
          lastVal: { $last: "$val" },
          allVals: { $push: "$val" },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const result = runMockPipeline(data, pipeline);
    expect(result).toEqual([
      {
        _id: "A",
        avgVal: 20,
        minVal: 10,
        maxVal: 30,
        firstVal: 10,
        lastVal: 30,
        allVals: [10, 30],
      },
      {
        _id: "B",
        avgVal: 50,
        minVal: 50,
        maxVal: 50,
        firstVal: 50,
        lastVal: 50,
        allVals: [50],
      },
    ]);
  });

  it("handles $elemMatch and $exists correctly on arrays and objects", () =>
  {
    const data = [
      { _id: 1, tags: ["tech", "news"], items: [{ sku: "A", qty: 5 }, { sku: "B", qty: 0 }] },
      { _id: 2, tags: ["gardening"], items: [{ sku: "C", qty: 2 }] },
      { _id: 3, items: [] },
    ];

    const elemMatchResult = runMockPipeline(data, [
      { $match: { items: { $elemMatch: { sku: "A", qty: { $gt: 0 } } } } },
    ]);
    expect(elemMatchResult).toHaveLength(1);
    expect(elemMatchResult[0]._id).toBe(1);

    const existsResult = runMockPipeline(data, [
      { $match: { tags: { $exists: true } } },
    ]);
    expect(existsResult).toHaveLength(2);

    const notExistsResult = runMockPipeline(data, [
      { $match: { tags: { $exists: false } } },
    ]);
    expect(notExistsResult).toHaveLength(1);
    expect(notExistsResult[0]._id).toBe(3);
  });
});
