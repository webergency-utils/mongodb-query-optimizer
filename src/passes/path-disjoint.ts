import { relatePaths } from '../analyzer/paths.js';

/**
 * Proof overlap: any relation other than disjoint is a hit, including an unknown path.
 * Analyzer overlap is a different answer and stays in the analyzer.
 */
export function arePathsDisjoint(
    left  : Iterable<string>,
    right : Iterable<string>
): boolean
{
    for( const leftPath of left )
    {
        for( const rightPath of right )
        {
            if( relatePaths( leftPath, rightPath ) !== 'disjoint' )
            {
                return false;
            }
        }
    }

    return true;
}
