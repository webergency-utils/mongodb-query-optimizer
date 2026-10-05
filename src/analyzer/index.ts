import {
  StageInfo,
  StageAnalyzerAdapter,
  StageSemantics,
} from "./types";
import { analyzeStage } from "./semantics";
import { MatchAnalyzer } from "./stages/match";
import { ProjectAnalyzer } from "./stages/project";
import { GroupAnalyzer } from "./stages/group";
import { LookupAnalyzer, GraphLookupAnalyzer } from "./stages/lookup";
import {
  SortAnalyzer,
  LimitSkipSampleAnalyzer,
  AddFieldsSetAnalyzer,
  UnsetAnalyzer,
  UnwindAnalyzer,
  CountAnalyzer,
  SortByCountAnalyzer,
  ReplaceRootAnalyzer,
  ReplaceWithAnalyzer,
  FacetAnalyzer,
  BucketAnalyzer,
  BucketAutoAnalyzer,
  SetWindowFieldsAnalyzer,
  DensifyAnalyzer,
  FillAnalyzer,
  DocumentsAnalyzer,
  UnionWithAnalyzer
} from "./stages/standard";

const REGISTRY: Record<string, StageAnalyzerAdapter> = {
  '$match': MatchAnalyzer,
  '$project': ProjectAnalyzer,
  '$group': GroupAnalyzer,
  '$lookup': LookupAnalyzer,
  '$graphLookup': GraphLookupAnalyzer,
  '$sort': SortAnalyzer,
  '$limit': LimitSkipSampleAnalyzer,
  '$skip': LimitSkipSampleAnalyzer,
  '$sample': LimitSkipSampleAnalyzer,
  '$addFields': AddFieldsSetAnalyzer,
  '$set': AddFieldsSetAnalyzer,
  '$unset': UnsetAnalyzer,
  '$unwind': UnwindAnalyzer,
  '$count': CountAnalyzer,
  '$sortByCount': SortByCountAnalyzer,
  '$replaceRoot': ReplaceRootAnalyzer,
  '$replaceWith': ReplaceWithAnalyzer,
  '$facet': FacetAnalyzer,
  '$bucket': BucketAnalyzer,
  '$bucketAuto': BucketAutoAnalyzer,
  '$setWindowFields': SetWindowFieldsAnalyzer,
  '$densify': DensifyAnalyzer,
  '$fill': FillAnalyzer,
  '$documents': DocumentsAnalyzer,
  '$unionWith': UnionWithAnalyzer,
};

function conservativeStageInfo(semantics: StageSemantics): StageInfo
{
  return {
    index: semantics.index,
    stage: semantics.stage,
    operator: semantics.operator,
    usedFields: new Set(["*"]),
    producedFields: new Set(["*"]),
    modifiedFields: new Set(["*"]),
    removedFields: new Set(),
    isDestructive: true,
    altersCount: true,
    isUnknown: true,
  };
}

function toStageInfo(semantics: StageSemantics): StageInfo
{
  const adapter = REGISTRY[semantics.operator];
  if (!adapter || semantics.malformed)
  {
    return conservativeStageInfo(semantics);
  }

  const info: StageInfo = {
    index: semantics.index,
    stage: semantics.stage,
    operator: semantics.operator,
    usedFields: new Set(),
    producedFields: new Set(),
    modifiedFields: new Set(),
    removedFields: new Set(),
    isDestructive: false,
    altersCount: false,
    isUnknown: false,
  };

  const value = (
    semantics.stage as Record<string, unknown>
  )[semantics.operator];
  adapter.analyze(value, info, getStageInfo);

  return info;
}

export function getStageInfo(stage: any, index: number): StageInfo
{
  return toStageInfo(analyzeStage(stage, index));
}

export { analyzePipeline, analyzeStage } from "./semantics";
export * from "./types";
