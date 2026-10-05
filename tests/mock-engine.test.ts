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
});
