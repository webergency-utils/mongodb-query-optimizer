import { PipelinePass } from './types';

/**
 * RedundantProjectionEliminationPass (Contained)
 *
 * Standalone redundant projection elimination across non-adjacent stages remains
 * safely contained. In MongoDB, projections are lossy without full schema knowledge,
 * and empty projections are invalid server syntax. Adjacent projections are safely
 * coalesced by the active `adjacent-project-merging` pass.
 */
export class RedundantProjectionEliminationPass implements PipelinePass
{
    name = 'redundant-projection-elimination';

    execute( pipeline: any[] ): any[]
    {
        return [ ...pipeline ];
    }
}

