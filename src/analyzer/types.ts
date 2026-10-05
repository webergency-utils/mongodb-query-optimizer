export interface StageInfo {
  index: number;
  stage: any;
  operator: string;
  usedFields: Set<string>;
  producedFields: Set<string>;
  modifiedFields: Set<string>;
  removedFields: Set<string>;
  isDestructive: boolean;
  altersCount: boolean;
  isUnknown: boolean;
}

export interface StageAnalyzerAdapter {
  analyze(
    val: any,
    info: Omit<StageInfo, 'operator' | 'index' | 'stage'>,
    getStageInfo?: (stage: any, index: number) => StageInfo
  ): void;
}

export type SemanticScope = "local" | "foreign";

export type CardinalityEffect =
  | "preserves"
  | "filters"
  | "expands"
  | "filters-and-expands"
  | "collapses"
  | "replaces"
  | "unknown";

export type OrderEffect =
  | "preserves"
  | "reorders"
  | "establishes"
  | "destroys"
  | "unknown";

export type StreamProvenance =
  | "local"
  | "foreign"
  | "local-and-foreign"
  | "generated"
  | "mixed"
  | "unknown";

export type Determinism =
  | "deterministic"
  | "volatile"
  | "unknown";

export type ErrorPossibility =
  | "none-known"
  | "may-error"
  | "unknown";

export interface ScopedDependencies {
  local: Set<string>;
  foreign: Set<string>;
  element: Set<string>;
  variables: Map<string, Set<string>>;
  unknown: boolean;
}

export interface DocumentBinding {
  readonly scope: SemanticScope;
  readonly path?: string;
  readonly wholeDocument?: boolean;
  readonly unknown?: boolean;
}

export interface SemanticAnalysisContext {
  readonly documentScope: SemanticScope;
  readonly variables?: ReadonlyMap<string, DocumentBinding>;
  readonly elementPath?: string;
  readonly inputProvenance?: StreamProvenance;
}

export interface ExpressionSummary {
  dependencies: ScopedDependencies;
  determinism: Determinism;
  errors: ErrorPossibility;
  unknown: boolean;
}

export interface FilterSummary extends ExpressionSummary {
  malformed: boolean;
}

export type ProjectionMode =
  | "inclusion"
  | "exclusion"
  | "add-fields"
  | "mixed"
  | "unknown";

export type IdProjection =
  | "default-included"
  | "included"
  | "excluded"
  | "computed"
  | "unknown";

export type PathVisibility =
  | "visible"
  | "partial"
  | "hidden"
  | "removed"
  | "unknown";

export interface ProjectionSummary {
  mode: ProjectionMode;
  id: IdProjection;
  includedPaths: Set<string>;
  excludedPaths: Set<string>;
  computedPaths: Set<string>;
  shieldsOmittedFields: boolean;
  collisions: Array<{
    readonly left: string;
    readonly right: string;
    readonly relation: "ancestor" | "descendant";
  }>;
  hasPathCollisions: boolean;
  unknown: boolean;
}

export interface ObservableSemantics {
  cardinality: CardinalityEffect;
  order: OrderEffect;
  provenance: StreamProvenance;
  determinism: Determinism;
  errors: ErrorPossibility;
  unknown: boolean;
}

export type ChildPipelineKind = "facet" | "lookup" | "unionWith";

export interface ChildPipelineSummary {
  kind: ChildPipelineKind;
  name?: string;
  scope: SemanticScope;
  outerDependencies: Set<string>;
  foreignDependencies: Set<string>;
  summary: PipelineSemantics;
}

export interface StageSemantics {
  index: number;
  stage: any;
  operator: string;
  dependencies: ScopedDependencies;
  writes: Set<string>;
  modifies: Set<string>;
  removes: Set<string>;
  projection?: ProjectionSummary;
  cardinality: CardinalityEffect;
  order: OrderEffect;
  provenance: StreamProvenance;
  determinism: Determinism;
  errors: ErrorPossibility;
  unknown: boolean;
  malformed: boolean;
  children: ChildPipelineSummary[];
  observable: ObservableSemantics;
}

export interface PipelineSemantics {
  stages: StageSemantics[];
  dependencies: ScopedDependencies;
  writes: Set<string>;
  modifies: Set<string>;
  removes: Set<string>;
  cardinality: CardinalityEffect;
  order: OrderEffect;
  provenance: StreamProvenance;
  determinism: Determinism;
  errors: ErrorPossibility;
  unknown: boolean;
  malformed: boolean;
  observable: ObservableSemantics;
}
