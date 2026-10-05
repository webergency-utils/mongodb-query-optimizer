import { StageAnalyzerAdapter } from '../types';
import { extractFieldsFromFilter } from '../utils';

export const MatchAnalyzer: StageAnalyzerAdapter = {
    analyze(val, info) {
        info.altersCount = true;
        info.usedFields = extractFieldsFromFilter(val);
    }
};
