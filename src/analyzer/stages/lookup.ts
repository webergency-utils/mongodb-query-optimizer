import { StageAnalyzerAdapter } from "../types";
import { extractExpressionFields, extractFieldsFromFilter } from "../utils";

export const LookupAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info, getStageInfo) {
    if (val && typeof val === 'object') {
      if (typeof val.as === 'string') {
        info.producedFields.add(val.as);
        info.modifiedFields.add(val.as);
      }
      if (typeof val.localField === 'string') {
        info.usedFields.add(val.localField);
      }
      if (val.let && typeof val.let === 'object') {
        for (const v of Object.values(val.let)) {
          extractExpressionFields(v, info.usedFields);
        }
      }
    }
  }
};

export const GraphLookupAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    if (val && typeof val === 'object') {
      if (typeof val.as === 'string') {
        info.producedFields.add(val.as);
        info.modifiedFields.add(val.as);
      }
      if (typeof val.depthField === 'string') {
        info.producedFields.add(val.depthField);
        info.modifiedFields.add(val.depthField);
      }
      if ('startWith' in val) {
        extractExpressionFields(val.startWith, info.usedFields);
      }
      if (typeof val.connectFromField === 'string') {
        info.usedFields.add(val.connectFromField);
      }
      if (typeof val.connectToField === 'string') {
        info.usedFields.add(val.connectToField);
      }
      if (val.restrictSearchWithMatch && typeof val.restrictSearchWithMatch === 'object') {
        const restrictUsed = extractFieldsFromFilter(val.restrictSearchWithMatch);
        for (const f of restrictUsed) {
          info.usedFields.add(f);
        }
      }
    }
  }
};
