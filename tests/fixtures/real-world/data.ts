import type { Document } from 'mongodb';
import { MIXED_SHAPE_CATALOG } from '../mixed-shapes.js';

export const REAL_WORLD_DATASET_SEED = 0x5eed_7001;

function seededRandom( seed: number ): () => number
{
    let state = seed >>> 0;

    return () =>
    {
        state += 0x6d2b_79f5;
        let value = state;
        value = Math.imul( value ^ ( value >>> 15 ), value | 1 );
        value ^= value + Math.imul( value ^ ( value >>> 7 ), value | 61 );

        return ( ( value ^ ( value >>> 14 ) ) >>> 0 ) / 0x1_0000_0000;
    };
}

export interface RealWorldDataset
{
    readonly jobs: Document[];
    readonly briefings: Document[];
    readonly placements: Document[];
}

export interface RealWorldDatasetOptions
{
    readonly count?: number;
    readonly seed?: number;
}

export function buildRealWorldDataset( options: RealWorldDatasetOptions = {} ): RealWorldDataset
{
    const count = options.count ?? 20;
    const seed = options.seed ?? REAL_WORLD_DATASET_SEED;
    const random = seededRandom( seed );

    const jobs: Document[] = [];
    const briefings: Document[] = [];
    const placements: Document[] = [];

    const currencyCodes =
    [
        'GBP',
        'EUR',
        'USD'
    ];
    const worktimeRates =
    [
        'year',
        'month',
        'day'
    ];
    const jobStatuses =
    [
        'open',
        'paused',
        'closed'
    ];
    const applicationStatuses =
    [
        'interviewing',
        'placed',
        'under-offer',
        'hired',
        'active'
    ];

    for( let i = 0; i < count; i++ )
    {
        const id = i + 1;
        const appId = `app-${id}-1`;

        let salaryValue: unknown;

        if( i < MIXED_SHAPE_CATALOG.length )
        {
            salaryValue = MIXED_SHAPE_CATALOG[i].createValue( i + 1 );
        }
        else
        {
            const baseMin = 30000 + Math.floor( random() * 20000 );
            const baseMax = baseMin + 10000 + Math.floor( random() * 15000 );
            const currency = currencyCodes[Math.floor( random() * currencyCodes.length )];
            const rate = worktimeRates[Math.floor( random() * worktimeRates.length )];

            salaryValue =
            {
                range:
                {
                    min: baseMin,
                    max: baseMax
                },
                currency,
                rate
            };
        }

        const isDeleted = i === 0;
        const appStatus = applicationStatuses[Math.floor( random() * applicationStatuses.length )];
        const jobStatus = jobStatuses[Math.floor( random() * jobStatuses.length )];

        const createdDate = new Date( Date.UTC( 2026, 0, 1 + ( i % 25 ) ) );
        const updatedDate = new Date( createdDate.getTime() + 86400000 );

        const jobDoc: Document =
        {
            _id: id,
            deleted: isDeleted,
            engagements:
            [
                {
                    status: 'active',
                    applications:
                    [
                        {
                            id: appId,
                            active: true,
                            status: appStatus,
                            events:
                            {
                                created: createdDate,
                                interviewing: updatedDate
                            },
                            history:
                            [
                                {
                                    status: appStatus,
                                    events:
                                    {
                                        created: createdDate
                                    }
                                }
                            ]
                        }
                    ]
                }
            ],
            positions:
            [
                {
                    active: true,
                    status: 'open',
                    events:
                    {
                        created: createdDate,
                        updated: updatedDate,
                        refreshed: updatedDate
                    }
                }
            ],
            events:
            {
                created: createdDate,
                updated: updatedDate,
                refreshed: updatedDate
            },
            history:
            [
                {
                    action: 'Job reopened',
                    events:
                    {
                        created: createdDate
                    }
                }
            ],
            settings:
            {
                engagement:
                {
                    cvs: 5
                }
            },
            status: jobStatus
        };

        if( salaryValue !== undefined )
        {
            jobDoc.employment =
            {
                salary: salaryValue
            };
        }

        jobs.push( jobDoc );

        briefings.push(
        {
            _id: `briefing-${id}`,
            relations:
            {
                jobIDs: [ id ],
                applicationIDs: [ appId ]
            },
            status: i % 3 === 0 ? 'cancelled' : 'completed',
            date:
            {
                end: new Date( createdDate.getTime() + 86400000 * 2 )
            }
        } );

        placements.push(
        {
            _id: `placement-${id}`,
            applicationID: appId,
            events:
            {
                created: new Date( createdDate.getTime() + 86400000 * 5 )
            }
        } );
    }

    return {
        jobs,
        briefings,
        placements
    };
}
