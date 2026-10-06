export interface PipelinePass
{
    readonly name        : string;
    readonly stageTypes? : readonly string[];
    execute( pipeline: any[] ): any[];
}
