export interface PipelinePass {
  name: string;
  execute(pipeline: any[]): any[];
}
