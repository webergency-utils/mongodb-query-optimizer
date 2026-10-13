import { DEFAULT_GUARANTEE_CONTEXT, GuaranteeContext } from '../guarantees.js';
import { PipelinePass } from './types.js';

type LimitSkipOperator = '$limit' | '$skip';

interface ParsedLimitSkipStage
{
    readonly operator: LimitSkipOperator;
    readonly value: unknown;
}

export interface LimitSkipCoalescingProof
{
    readonly operator: LimitSkipOperator;
    readonly leftValue: number;
    readonly rightValue: number;
    readonly coalescedValue: number;
    readonly replacementStage:
        | Readonly<{ $limit: number }>
        | Readonly<{ $skip: number }>;
}

function parseStrictStage(stage: unknown): ParsedLimitSkipStage | null
{
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage))
    {
        return null;
    }

    const prototype = Object.getPrototypeOf(stage);
    if (prototype !== Object.prototype && prototype !== null)
    {
        return null;
    }

    const entries = Object.entries(stage);
    if (entries.length !== 1)
    {
        return null;
    }

    const [operator, value] = entries[0]!;
    if (operator !== '$limit' && operator !== '$skip')
    {
        return null;
    }

    return {
        operator,
        value,
    };
}

function isValidOperand(
    operator: LimitSkipOperator,
    value: unknown,
): value is number
{
    return (
        typeof value === 'number'
        && Number.isSafeInteger(value)
        && (
            operator === '$limit'
                ? value > 0
                : value >= 0
        )
    );
}

/**
 * Proves one exact adjacent limit/skip coalescing step.
 *
 * Both inputs must be strict one-key stages with primitive JavaScript safe
 * integers. Limit uses exact minimum. Skip uses exact addition only while the
 * mathematical sum remains in JavaScript's safe-integer range.
 */
export function proveLimitSkipCoalescing(
    leftStage: unknown,
    rightStage: unknown,
): LimitSkipCoalescingProof | null
{
    const left = parseStrictStage(leftStage);
    const right = parseStrictStage(rightStage);
    if (
        !left
        || !right
        || left.operator !== right.operator
        || !isValidOperand(left.operator, left.value)
        || !isValidOperand(right.operator, right.value)
    )
    {
        return null;
    }

    let coalescedValue: number;
    if (left.operator === '$limit')
    {
        coalescedValue = Math.min(left.value, right.value);
    }
    else
    {
        if (left.value > Number.MAX_SAFE_INTEGER - right.value)
        {
            return null;
        }

        coalescedValue = left.value + right.value;
    }

    return {
        operator: left.operator,
        leftValue: left.value,
        rightValue: right.value,
        coalescedValue,
        replacementStage: left.operator === '$limit'
            ? { $limit: coalescedValue }
            : { $skip: coalescedValue },
    };
}

export interface LimitBeforeSkipNormalizationProof
{
    readonly skipStage: Readonly<{ $skip: number }>;
    readonly limitStage: Readonly<{ $limit: number }>;
}

/**
 * Proves that `{ $limit: L }, { $skip: S }` with `L > S > 0` can be rewritten
 * to `{ $skip: S }, { $limit: L - S }` while pulling the exact same number of
 * upstream documents (`S + (L - S) = L`).
 */
export function proveLimitBeforeSkipNormalization(
    leftStage: unknown,
    rightStage: unknown,
): LimitBeforeSkipNormalizationProof | null
{
    const left = parseStrictStage(leftStage);
    const right = parseStrictStage(rightStage);
    if (
        !left
        || !right
        || left.operator !== '$limit'
        || right.operator !== '$skip'
        || !isValidOperand('$limit', left.value)
        || !isValidOperand('$skip', right.value)
        || right.value <= 0
        || left.value <= right.value
    )
    {
        return null;
    }

    return {
        skipStage: { $skip: right.value },
        limitStage: { $limit: left.value - right.value },
    };
}

export function isZeroSkip(stage: unknown): boolean
{
    const parsed = parseStrictStage(stage);
    return parsed !== null && parsed.operator === '$skip' && parsed.value === 0;
}

export class LimitSkipCoalescingPass implements PipelinePass
{
    readonly name       = 'limit-skip-coalescing';
    readonly stageTypes = [ '$limit', '$skip' ] as const;

    execute( pipeline: any[], _context: GuaranteeContext = DEFAULT_GUARANTEE_CONTEXT ): any[]
    {
        const result = [...pipeline];

        for (let index = 0; index + 1 < result.length; index++)
        {
            const proof = proveLimitSkipCoalescing(
                result[index],
                result[index + 1],
            );
            if (proof)
            {
                result.splice(index, 2, proof.replacementStage);
                return result;
            }

            const normProof = proveLimitBeforeSkipNormalization(
                result[index],
                result[index + 1],
            );
            if (normProof)
            {
                result.splice(index, 2, normProof.skipStage, normProof.limitStage);
                return result;
            }
        }

        for (let index = 0; index < result.length; index++)
        {
            if (isZeroSkip(result[index]))
            {
                result.splice(index, 1);
                return result;
            }
        }

        return result;
    }
}
