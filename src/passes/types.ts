import { GuaranteeContext } from '../guarantees';

export interface PipelinePass
{
    readonly name        : string;
    readonly stageTypes? : readonly string[];
    /**
     * Rewrites one pipeline level. The scheduler passes the same resolved guarantees
     * to every pass and into every sub-pipeline sweep.
     */
    execute( pipeline: any[], context: GuaranteeContext ): any[];
}
